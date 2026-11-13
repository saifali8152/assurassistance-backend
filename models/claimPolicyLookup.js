// models/claimPolicyLookup.js
//
// Milestone 4, Day 2 — "which policy is this, and is it really yours?"
//
// The customer gives two things: a policy number (or assistance-card number)
// and their passport / ID number. A policy is identified only when BOTH point
// at the same row. Then the rules in utils/claims/policyRules.js decide what
// that policy may claim.
//
// READ-ONLY ON LIVE DATA. This file SELECTs from sales, cases, travellers,
// certificates and catalogue. The only table it writes is
// claim_validation_attempts.
//
// WHAT AN ATTACKER LEARNS: nothing. "No such policy" and "wrong passport" are
// the same outcome to the customer (the log keeps them apart, for us). Nothing
// about the policy — not the holder's name, not the dates — is returned before
// both identifiers match. Guessing is throttled per WhatsApp number AND per
// policy, durably (in the database, so a restart does not reset it), and every
// attempt is logged with the identifier hashed, never in clear.
//
import crypto from "crypto";
import { getPool } from "../utils/db.js";
import { passportHash, normalisePassport, readPassport } from "../utils/travellerPrivacy.js";
import {
  evaluatePolicyAtValidation, guaranteeCodesFromRules, normaliseIdentifier, looksLikeCardNumber, toYmd,
} from "../utils/claims/policyRules.js";

/** Outcomes that count towards a lockout: the ones a guesser produces. */
export const FAILED_OUTCOMES = ["not_found", "mismatch"];
const POLICY_WINDOW_HOURS = 24;

/** Keyed hash of what was typed, so the attempts log never holds a policy number in clear. */
export function identifierHash(identifier) {
  const norm = normaliseIdentifier(identifier);
  if (!norm) return null;
  const key = process.env.SETTINGS_ENCRYPTION_KEY || "";
  return key
    ? crypto.createHmac("sha256", key).update(`claim-identifier:${norm}`).digest("hex")
    : crypto.createHash("sha256").update(`claim-identifier:${norm}`).digest("hex");
}

function sameHex(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
  } catch {
    return false;
  }
}

/**
 * Does the typed passport match the row? Compared as keyed hashes — the row's
 * stored blind index when it has one — never as plaintext strings.
 */
export function passportMatches(typed, row) {
  const typedNorm = normalisePassport(typed);
  if (!typedNorm || !row) return false;
  const typedHash = passportHash(typedNorm);
  if (typedHash) {
    const rowHash = row.passport_or_id_hash || passportHash(readPassport(row));
    return sameHex(typedHash, rowHash);
  }
  // No key configured (a dev machine): hash both sides the same unkeyed way.
  const stored = normalisePassport(readPassport(row));
  if (!stored) return false;
  const h = (v) => crypto.createHash("sha256").update(`passport:${v}`).digest("hex");
  return sameHex(h(typedNorm), h(stored));
}

/* ------------------------------------------------------------- throttling */

/**
 * Is this number, or this policy, locked out right now?
 * @returns { locked:false } | { locked:true, scope:'number'|'policy', retryAfterMinutes }
 */
export async function checkValidationLock({ waNumber, identifier = null, config }, conn = null) {
  const db = conn || getPool();
  const max = Math.max(1, Number(config?.maxAttempts) || 3);
  const lockout = Math.max(1, Number(config?.lockoutMinutes) || 30);
  const digits = String(waNumber || "").replace(/\D/g, "");

  const [byNumber] = await db.query(
    `SELECT COUNT(*) AS n,
            GREATEST(0, ? - TIMESTAMPDIFF(MINUTE, MAX(created_at), NOW())) AS wait
       FROM claim_validation_attempts
      WHERE wa_number = ? AND outcome IN (?) AND created_at >= NOW() - INTERVAL ? MINUTE`,
    [lockout, digits, FAILED_OUTCOMES, lockout]
  );
  if (Number(byNumber[0]?.n) >= max) {
    return { locked: true, scope: "number", retryAfterMinutes: Math.max(1, Number(byNumber[0].wait) || 1) };
  }

  const hash = identifier ? identifierHash(identifier) : null;
  const perPolicy = Math.max(1, Number(config?.maxPerPolicy) || 5);
  if (hash) {
    const [byPolicy] = await db.query(
      `SELECT COUNT(*) AS n,
              GREATEST(0, ? - TIMESTAMPDIFF(MINUTE, MIN(created_at), NOW())) AS wait
         FROM claim_validation_attempts
        WHERE identifier_hash = ? AND outcome IN (?) AND created_at >= NOW() - INTERVAL ? HOUR`,
      [POLICY_WINDOW_HOURS * 60, hash, FAILED_OUTCOMES, POLICY_WINDOW_HOURS]
    );
    if (Number(byPolicy[0]?.n) >= perPolicy) {
      return { locked: true, scope: "policy", retryAfterMinutes: Math.max(1, Number(byPolicy[0].wait) || 1) };
    }
  }
  return { locked: false };
}

export async function recordValidationAttempt({ waNumber, sessionId = null, identifier = null, outcome }, conn = null) {
  await (conn || getPool()).execute(
    `INSERT INTO claim_validation_attempts (wa_number, session_id, identifier_hash, outcome) VALUES (?, ?, ?, ?)`,
    [String(waNumber || "").replace(/\D/g, ""), sessionId, identifier ? identifierHash(identifier) : null, outcome]
  );
}

/** How many attempts this number has left before it is locked (for "2 tries left"). */
export async function attemptsLeft({ waNumber, config }, conn = null) {
  const max = Math.max(1, Number(config?.maxAttempts) || 3);
  const lockout = Math.max(1, Number(config?.lockoutMinutes) || 30);
  const [rows] = await (conn || getPool()).query(
    `SELECT COUNT(*) AS n FROM claim_validation_attempts
      WHERE wa_number = ? AND outcome IN (?) AND created_at >= NOW() - INTERVAL ? MINUTE`,
    [String(waNumber || "").replace(/\D/g, ""), FAILED_OUTCOMES, lockout]
  );
  return Math.max(0, max - Number(rows[0]?.n || 0));
}

/* ----------------------------------------------------------------- lookup */

function parseJson(raw, fallback) {
  if (raw == null || raw === "") return fallback;
  if (typeof raw === "object") return raw;
  try { return JSON.parse(raw); } catch { return fallback; }
}

/** A sale row → the one shape the rules and the flow use. Dates from the issued snapshot. */
function fromSale(row) {
  const snap = parseJson(row.issued_snapshot, null);
  const cancelled = Boolean(row.deleted_at) || row.case_status === "Cancelled";
  return {
    source: "sale",
    saleId: row.sale_id,
    externalPolicyId: null,
    caseId: row.case_id,
    policyNumber: row.policy_number,
    certificateNumber: row.certificate_number || null,
    holderFirstName: snap?.traveller?.first_name ?? row.first_name ?? null,
    holderLastName: snap?.traveller?.last_name ?? row.last_name ?? null,
    planName: snap?.plan?.name ?? row.plan_name ?? null,
    insurer: row.partner_insurer || null,
    startDate: toYmd(snap?.trip?.start_date) || toYmd(row.start_date),
    endDate: toYmd(snap?.trip?.end_date) || toYmd(row.end_date),
    status: cancelled ? "cancelled" : "active",
    paymentStatus: row.payment_status === "Paid" ? "paid" : "unpaid",
    guaranteeCodes: guaranteeCodesFromRules(row.pricing_rules),
    isTest: false,
    _passportRow: row,
    _rank: (cancelled ? 2 : 0),
  };
}

function fromExternal(row) {
  return {
    source: "external",
    saleId: null,
    externalPolicyId: row.id,
    caseId: null,
    policyNumber: row.policy_number,
    certificateNumber: null,
    cardNumber: row.card_number || null,
    holderFirstName: row.holder_first_name || null,
    holderLastName: row.holder_last_name || null,
    planName: row.product_name || null,
    insurer: row.insurer || null,
    startDate: toYmd(row.start_date),
    endDate: toYmd(row.end_date),
    status: row.status === "cancelled" ? "cancelled" : "active",
    paymentStatus: ["paid", "unpaid"].includes(row.payment_status) ? row.payment_status : "unknown",
    guaranteeCodes: (() => {
      const g = parseJson(row.guarantee_codes, null);
      return Array.isArray(g) && g.length ? g : null;
    })(),
    isTest: Boolean(Number(row.is_test)),
    _passportRow: row,
    _rank: 1 + (row.status === "cancelled" ? 2 : 0),
  };
}

/**
 * Every policy the typed number could mean. Usually one; never trusted until
 * the passport picks one of them.
 */
export async function findPolicyCandidates(identifier, config = {}, conn = null) {
  const db = conn || getPool();
  const id = normaliseIdentifier(identifier);
  if (!id) return [];
  const mode = config.cardNumberMode || "certificate";
  const card = looksLikeCardNumber(id, config);
  const out = [];

  // A separate-format card number only ever lives on an imported policy.
  if (!card) {
    const [sales] = await db.query(
      `SELECT s.id AS sale_id, s.case_id, s.policy_number, s.certificate_number, s.payment_status, s.deleted_at,
              c.status AS case_status, c.start_date, c.end_date, c.selected_plan_id,
              t.first_name, t.last_name, t.passport_or_id, t.passport_or_id_enc, t.passport_or_id_hash,
              cert.issued_snapshot, cat.name AS plan_name, cat.pricing_rules, cat.partner_insurer
         FROM sales s
         JOIN cases c ON c.id = s.case_id
         JOIN travellers t ON t.id = c.traveller_id
         LEFT JOIN certificates cert ON cert.sale_id = s.id
         LEFT JOIN catalogue cat ON cat.id = c.selected_plan_id
        WHERE s.policy_number = ? ${mode === "certificate" ? "OR s.certificate_number = ?" : ""}
        LIMIT 10`,
      mode === "certificate" ? [id, id] : [id]
    );
    out.push(...sales.map(fromSale));
  }

  const [ext] = await db.query(
    `SELECT id, policy_number, card_number, holder_first_name, holder_last_name,
            passport_or_id_enc, passport_or_id_hash, product_name, insurer, start_date, end_date,
            status, payment_status, guarantee_codes, is_test
       FROM external_policies
      WHERE ${card ? "card_number = ?" : mode === "none" ? "policy_number = ?" : "(policy_number = ? OR card_number = ?)"}
      LIMIT 10`,
    card || mode === "none" ? [id] : [id, id]
  );
  out.push(...ext.map(fromExternal));
  return out;
}

/** What the conversation keeps in its session: enough to run the claim, nothing more. */
export function sessionPolicy(policy, flags = []) {
  if (!policy) return null;
  return {
    source: policy.source,
    saleId: policy.saleId,
    externalPolicyId: policy.externalPolicyId,
    policyNumber: policy.policyNumber,
    holderFirstName: policy.holderFirstName,
    planName: policy.planName,
    startDate: policy.startDate,
    endDate: policy.endDate,
    guaranteeCodes: policy.guaranteeCodes,
    isTest: policy.isTest,
    flags,
  };
}

/** What the claim record keeps of the policy as it was on filing — never the passport. */
export function claimPolicySnapshot(policy) {
  if (!policy) return null;
  return {
    source: policy.source,
    sale_id: policy.saleId,
    external_policy_id: policy.externalPolicyId,
    policy_number: policy.policyNumber,
    certificate_number: policy.certificateNumber || null,
    card_number: policy.cardNumber || null,
    holder_first_name: policy.holderFirstName,
    holder_last_name: policy.holderLastName,
    plan_name: policy.planName,
    insurer: policy.insurer,
    start_date: policy.startDate,
    end_date: policy.endDate,
    status: policy.status,
    payment_status: policy.paymentStatus,
    guarantee_codes: policy.guaranteeCodes,
    captured_at: new Date().toISOString(),
  };
}

/**
 * The whole check, as the conversation calls it.
 *
 * @returns
 *   { ok:true, policy, session, flags }
 *   { ok:false, outcome:'locked', retryAfterMinutes }
 *   { ok:false, outcome:'not_found', attemptsLeft }   ← also for a passport mismatch
 *   { ok:false, outcome:'cancelled'|'unpaid'|'expired'|'out_of_window'|'not_started'|'no_dates', policy? }
 */
export async function validatePolicy({ waNumber, sessionId = null, identifier, passport, today = new Date(), config = {} }) {
  const lock = await checkValidationLock({ waNumber, identifier, config });
  if (lock.locked) {
    await recordValidationAttempt({ waNumber, sessionId, identifier, outcome: "locked" });
    return { ok: false, outcome: "locked", retryAfterMinutes: lock.retryAfterMinutes, scope: lock.scope };
  }

  const candidates = await findPolicyCandidates(identifier, config);
  const matching = candidates
    .filter((p) => passportMatches(passport, p._passportRow))
    .sort((a, b) => a._rank - b._rank);

  if (!matching.length) {
    const logged = candidates.length ? "mismatch" : "not_found";
    await recordValidationAttempt({ waNumber, sessionId, identifier, outcome: logged });
    // The customer is told the same thing either way.
    return { ok: false, outcome: "not_found", attemptsLeft: await attemptsLeft({ waNumber, config }) };
  }

  const { _passportRow, _rank, ...policy } = matching[0];
  const verdict = evaluatePolicyAtValidation(policy, { today, config });
  await recordValidationAttempt({ waNumber, sessionId, identifier, outcome: verdict.ok ? "success" : verdict.outcome });

  if (!verdict.ok) {
    // Identity is proven at this point, so explaining WHY is safe and useful.
    return { ok: false, outcome: verdict.outcome, policy: sessionPolicy(policy), endDate: verdict.endDate, startDate: verdict.startDate, windowDays: verdict.windowDays };
  }
  return { ok: true, policy, session: sessionPolicy(policy, verdict.flags), flags: verdict.flags };
}

/**
 * The policy behind a claim, by id — for the snapshot taken at submission.
 * Same shape as a lookup result; the passport row is stripped.
 */
export async function loadPolicyForClaim({ saleId = null, externalPolicyId = null }, conn = null) {
  const db = conn || getPool();
  let policy = null;
  if (saleId) {
    const [rows] = await db.query(
      `SELECT s.id AS sale_id, s.case_id, s.policy_number, s.certificate_number, s.payment_status, s.deleted_at,
              c.status AS case_status, c.start_date, c.end_date, c.selected_plan_id,
              t.first_name, t.last_name,
              cert.issued_snapshot, cat.name AS plan_name, cat.pricing_rules, cat.partner_insurer
         FROM sales s
         JOIN cases c ON c.id = s.case_id
         JOIN travellers t ON t.id = c.traveller_id
         LEFT JOIN certificates cert ON cert.sale_id = s.id
         LEFT JOIN catalogue cat ON cat.id = c.selected_plan_id
        WHERE s.id = ? LIMIT 1`,
      [saleId]
    );
    if (rows[0]) policy = fromSale(rows[0]);
  } else if (externalPolicyId) {
    const [rows] = await db.query(
      `SELECT id, policy_number, card_number, holder_first_name, holder_last_name, product_name, insurer,
              start_date, end_date, status, payment_status, guarantee_codes, is_test
         FROM external_policies WHERE id = ? LIMIT 1`,
      [externalPolicyId]
    );
    if (rows[0]) policy = fromExternal(rows[0]);
  }
  if (!policy) return null;
  const { _passportRow, _rank, ...clean } = policy;
  return clean;
}
