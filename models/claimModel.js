// src/models/claimModel.js
//
// Claims and their status history.
//
// THE ONE RULE OF THIS FILE: it reads `sales`, `cases`, `travellers` and
// `certificates` and never writes to them. Every write here lands in a claims
// table. The live purchase data is somebody's insurance; a claims bug must not
// be able to touch it.
//
// Every status change goes through transition(), which locks the claim row,
// checks the move against the state machine and writes the history row in the
// same transaction — so a claim can never be in a state its history doesn't
// explain.
//
import getPool from "../utils/db.js";
import { allocateNumber } from "../utils/documentNumbers.js";
import { canTransition } from "../utils/claims/stateMachine.js";
import { loadPolicyForClaim, claimPolicySnapshot } from "./claimPolicyLookup.js";

function parseJson(raw, fallback) {
  if (raw === null || raw === undefined) return fallback;
  if (typeof raw === "object") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

export function mapClaim(row) {
  if (!row) return null;
  return {
    id: row.id,
    reference: row.reference,
    status: row.status,
    priority: row.priority,
    saleId: row.sale_id,
    externalPolicyId: row.external_policy_id,
    policyNumber: row.policy_number,
    holderName: row.holder_name,
    waNumber: row.wa_number,
    sessionId: row.session_id,
    language: row.language,
    categoryCode: row.category_code,
    subcategoryCode: row.subcategory_code,
    incidentDate: row.incident_date,
    incidentCountryCode: row.incident_country_code,
    incidentCountry: row.incident_country,
    incidentCity: row.incident_city,
    description: row.description,
    extraFields: parseJson(row.extra_fields, {}),
    flags: parseJson(row.flags, []),
    policySnapshot: parseJson(row.policy_snapshot, null),
    isTest: Boolean(Number(row.is_test)),
    consentAcceptedAt: row.consent_accepted_at,
    submittedAt: row.submitted_at,
    closedAt: row.closed_at,
    abandonedAt: row.abandoned_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function getClaimById(id, conn = null) {
  const [rows] = await (conn || getPool()).query(`SELECT * FROM claims WHERE id = ? LIMIT 1`, [id]);
  return mapClaim(rows[0]);
}

export async function getClaimByReference(reference, conn = null) {
  const ref = String(reference || "").trim().toUpperCase();
  if (!ref) return null;
  const [rows] = await (conn || getPool()).query(`SELECT * FROM claims WHERE reference = ? LIMIT 1`, [ref]);
  return mapClaim(rows[0]);
}

/**
 * Open a draft for a validated policy.
 * The policy reference is fixed here; everything else is filled in as the
 * conversation goes.
 */
export async function createDraft({
  waNumber, sessionId = null, language = "fr", saleId = null, externalPolicyId = null,
  policyNumber = null, holderName = null, isTest = false, flags = [],
}, conn = null) {
  if (!saleId && !externalPolicyId) throw new Error("A claim needs a policy");
  const db = conn || getPool();
  const [res] = await db.execute(
    `INSERT INTO claims (status, sale_id, external_policy_id, policy_number, holder_name, wa_number,
                         session_id, language, is_test, flags)
     VALUES ('draft', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      saleId, externalPolicyId, policyNumber, holderName ? String(holderName).slice(0, 255) : null,
      String(waNumber || "").replace(/\D/g, ""), sessionId, language === "en" ? "en" : "fr",
      isTest ? 1 : 0, JSON.stringify(flags || []),
    ]
  );
  await db.execute(
    `INSERT INTO claim_status_history (claim_id, from_status, to_status, changed_by) VALUES (?, NULL, 'draft', 'customer')`,
    [res.insertId]
  );
  return res.insertId;
}

const DRAFT_FIELDS = {
  categoryCode: "category_code",
  subcategoryCode: "subcategory_code",
  incidentDate: "incident_date",
  incidentCountryCode: "incident_country_code",
  incidentCountry: "incident_country",
  incidentCity: "incident_city",
  description: "description",
  extraFields: "extra_fields",
  flags: "flags",
  priority: "priority",
  language: "language",
  consentAcceptedAt: "consent_accepted_at",
};

/**
 * Write the answers gathered so far onto a DRAFT. Refuses anything that is no
 * longer a draft: once submitted, what the customer sent is a record.
 */
export async function updateDraft(claimId, patch, conn = null) {
  const sets = [];
  const params = [];
  for (const [k, col] of Object.entries(DRAFT_FIELDS)) {
    if (patch[k] === undefined) continue;
    sets.push(`${col} = ?`);
    const v = patch[k];
    params.push(k === "extraFields" || k === "flags" ? JSON.stringify(v ?? (k === "flags" ? [] : {})) : v);
  }
  if (!sets.length) return false;
  const [res] = await (conn || getPool()).execute(
    `UPDATE claims SET ${sets.join(", ")} WHERE id = ? AND status = 'draft'`,
    [...params, claimId]
  );
  return res.affectedRows > 0;
}

/**
 * Move a claim to a new status, with its history, atomically.
 * Returns { ok, from, to } or { ok:false, reason }.
 */
export async function transition(claimId, to, { by = "system", userId = null, note = null, conn = null } = {}) {
  const own = !conn;
  const db = conn || (await getPool().getConnection());
  try {
    if (own) await db.beginTransaction();
    const [rows] = await db.query(`SELECT id, status FROM claims WHERE id = ? FOR UPDATE`, [claimId]);
    if (!rows[0]) {
      if (own) await db.rollback();
      return { ok: false, reason: "not_found" };
    }
    const from = rows[0].status;
    if (!canTransition(from, to)) {
      if (own) await db.rollback();
      return { ok: false, reason: "illegal_transition", from, to };
    }
    const stamp =
      to === "submitted" ? ", submitted_at = COALESCE(submitted_at, NOW())"
        : to === "closed" ? ", closed_at = NOW()"
        : to === "abandoned" ? ", abandoned_at = NOW()" : "";
    await db.execute(`UPDATE claims SET status = ?${stamp} WHERE id = ?`, [to, claimId]);
    await db.execute(
      `INSERT INTO claim_status_history (claim_id, from_status, to_status, changed_by_user_id, changed_by, note)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [claimId, from, to, userId, userId ? "user" : by, note ? String(note).slice(0, 500) : null]
    );
    if (own) await db.commit();
    return { ok: true, from, to };
  } catch (err) {
    if (own) {
      try { await db.rollback(); } catch { /* released below */ }
    }
    throw err;
  } finally {
    if (own) db.release();
  }
}

export async function getStatusHistory(claimId) {
  const [rows] = await getPool().query(
    `SELECT h.id, h.from_status, h.to_status, h.changed_by, h.changed_by_user_id, u.name AS changed_by_name,
            h.note, h.created_at
       FROM claim_status_history h
       LEFT JOIN users u ON u.id = h.changed_by_user_id
      WHERE h.claim_id = ?
      ORDER BY h.id ASC`,
    [claimId]
  );
  return rows;
}

/** A case number, from the configured format, atomically. `conn` must be one connection. */
export async function allocateClaimReference(conn, format) {
  return allocateNumber(conn, "claim", format || "SIN-{YYYY}-{SEQ:6}");
}

/* ------------------------------------------- conversation support (Days 3–4) */

/**
 * Mark a draft abandoned. Only a draft: anything submitted is a record and is
 * never abandoned from the conversation. The row stays (D9).
 */
export async function abandonDraft(claimId, reason = null, { by = "customer" } = {}) {
  if (!claimId) return { ok: false, reason: "no_claim" };
  const claim = await getClaimById(claimId);
  if (!claim || claim.status !== "draft") return { ok: false, reason: "not_a_draft" };
  return transition(claimId, "abandoned", { by, note: reason });
}

/**
 * An unfinished claim this number can pick up again: the draft behind the
 * most recent conversation that ended (expired, usually) in the middle of a
 * claim, if it is still a draft and recent enough.
 *
 * @returns {{ claimId, state, step } | null}
 */
export async function findResumableDraft({ waNumber, excludeSessionId = null, maxAgeHours = 48 }) {
  const digits = String(waNumber || "").replace(/\D/g, "");
  if (!digits) return null;
  const [rows] = await getPool().query(
    `SELECT s.id AS session_id, s.current_step, s.collected_data, s.claim_id
       FROM whatsapp_sessions s
       JOIN claims c ON c.id = s.claim_id
      WHERE s.wa_number = ?
        AND s.status <> 'active'
        AND (? IS NULL OR s.id <> ?)
        AND s.current_step LIKE 'claim\\_%'
        AND c.status = 'draft'
        AND c.updated_at >= NOW() - INTERVAL ? HOUR
      ORDER BY s.updated_at DESC
      LIMIT 1`,
    [digits, excludeSessionId, excludeSessionId, Number(maxAgeHours) || 48]
  );
  const row = rows[0];
  if (!row) return null;
  const data = parseJson(row.collected_data, {});
  const state = data?.__claim;
  if (!state?.policy) return null;
  return { claimId: row.claim_id, state: { ...state, claimId: row.claim_id }, step: row.current_step };
}

/**
 * "SUIVI <ref>": the claim with this reference, only if it was filed from this
 * number. Anything else — unknown reference, someone else's claim, a draft —
 * is the same "not found", so a reference cannot be used to probe.
 */
export async function trackClaimForNumber({ waNumber, reference }) {
  const digits = String(waNumber || "").replace(/\D/g, "");
  const ref = String(reference || "").trim().toUpperCase();
  if (!digits || !ref) return null;
  const [rows] = await getPool().query(
    `SELECT c.reference, c.status, c.submitted_at, c.wa_number,
            COALESCE(sub.name_fr, cat.name_fr) AS category_fr, COALESCE(sub.name_en, cat.name_en) AS category_en
       FROM claims c
       LEFT JOIN claim_categories sub ON sub.code = c.subcategory_code
       LEFT JOIN claim_categories cat ON cat.code = c.category_code
      WHERE c.reference = ? AND c.status IN ('submitted','under_review','closed')
      LIMIT 1`,
    [ref]
  );
  const row = rows[0];
  if (!row || String(row.wa_number) !== digits) return null;
  return {
    reference: row.reference,
    status: row.status,
    submittedAt: row.submitted_at,
    categoryFr: row.category_fr,
    categoryEn: row.category_en,
  };
}

/**
 * Drafts left untouched for longer than `hours` become `abandoned` — marked,
 * with history, never deleted (D9). Run from cron.
 */
export async function abandonStaleDrafts({ hours = 48, dryRun = false, limit = 500 } = {}) {
  const [rows] = await getPool().query(
    `SELECT id FROM claims WHERE status = 'draft' AND updated_at < NOW() - INTERVAL ? HOUR ORDER BY id LIMIT ?`,
    [Number(hours) || 48, Number(limit) || 500]
  );
  if (dryRun) return { found: rows.length, abandoned: 0, ids: rows.map((r) => r.id) };
  let abandoned = 0;
  for (const r of rows) {
    const res = await transition(r.id, "abandoned", { by: "system", note: `no activity for ${hours} hours` });
    if (res.ok) abandoned += 1;
  }
  return { found: rows.length, abandoned, ids: rows.map((r) => r.id) };
}

/* ------------------------------------------------------- submission (Day 6) */

/**
 * Turn a draft into a claim, on the customer's confirmed submit only.
 *
 * One transaction: the final answers, the policy snapshot as it stands now,
 * the case number, `draft → submitted` with its history row, and the outbox
 * row that will email the claims team. Either all of it happens or none of it.
 *
 * Idempotent: a second tap on "Submit" for a claim that already went through
 * returns the same reference rather than an error or a second number.
 *
 * @returns {{ ok:true, reference, claimId, priority } | { ok:false, reason }}
 */
export async function submitClaim({ claimId, state, language = "fr", waNumber, config = {} }) {
  if (!claimId) return { ok: false, reason: "no_claim" };
  const digits = String(waNumber || "").replace(/\D/g, "");
  const conn = await getPool().getConnection();
  try {
    await conn.beginTransaction();
    const [rows] = await conn.query(`SELECT * FROM claims WHERE id = ? FOR UPDATE`, [claimId]);
    const claim = rows[0];
    if (!claim) {
      await conn.rollback();
      return { ok: false, reason: "not_found" };
    }
    if (digits && String(claim.wa_number) !== digits) {
      await conn.rollback();
      return { ok: false, reason: "not_owner" };
    }
    if (claim.status !== "draft") {
      await conn.rollback();
      return claim.reference && claim.status !== "abandoned"
        ? { ok: true, reference: claim.reference, claimId, priority: claim.priority, alreadySubmitted: true }
        : { ok: false, reason: `status_${claim.status}` };
    }

    const policy = await loadPolicyForClaim({ saleId: claim.sale_id, externalPolicyId: claim.external_policy_id }, conn);
    const snapshot = policy ? claimPolicySnapshot(policy) : parseJson(claim.policy_snapshot, null);
    const holder = policy ? [policy.holderFirstName, policy.holderLastName].filter(Boolean).join(" ") : claim.holder_name;
    const priority = ["normal", "high", "urgent"].includes(state?.priority) ? state.priority : claim.priority || "normal";
    const reference = await allocateClaimReference(conn, config.numberFormat);

    await conn.execute(
      `UPDATE claims
          SET reference = ?, priority = ?, holder_name = ?, policy_snapshot = ?, language = ?,
              category_code = ?, subcategory_code = ?, incident_date = ?, incident_country_code = ?,
              incident_country = ?, incident_city = ?, description = ?, extra_fields = ?, flags = ?,
              consent_accepted_at = ?
        WHERE id = ?`,
      [
        reference,
        priority,
        holder ? String(holder).slice(0, 255) : null,
        snapshot ? JSON.stringify(snapshot) : null,
        language === "en" ? "en" : "fr",
        state?.category?.code ?? claim.category_code,
        state?.subcategory?.code ?? claim.subcategory_code,
        state?.incidentDate ?? claim.incident_date,
        state?.countryCode ?? claim.incident_country_code,
        state?.country ?? claim.incident_country,
        state?.city ?? claim.incident_city,
        state?.description ?? claim.description,
        JSON.stringify(state?.fields ?? parseJson(claim.extra_fields, {})),
        JSON.stringify(state?.flags ?? parseJson(claim.flags, [])),
        state?.consentAcceptedAt ? new Date(state.consentAcceptedAt) : null,
        claimId,
      ]
    );

    const moved = await transition(claimId, "submitted", { by: "customer", conn });
    if (!moved.ok) {
      await conn.rollback();
      return { ok: false, reason: moved.reason };
    }

    // Recipients are resolved when the mail is sent, so a row is always
    // written; with nobody configured it is recorded as skipped — the claim is
    // on the dashboard either way.
    const hasRecipients = Array.isArray(config.notificationEmails) && config.notificationEmails.length > 0;
    await conn.execute(
      `INSERT IGNORE INTO claim_notifications (claim_id, channel, priority, status, next_attempt_at)
       VALUES (?, 'email', ?, ?, ${hasRecipients ? "NOW()" : "NULL"})`,
      [claimId, priority, hasRecipients ? "pending" : "skipped"]
    );

    await conn.commit();
    return { ok: true, reference, claimId, priority };
  } catch (err) {
    try { await conn.rollback(); } catch { /* released below */ }
    throw err;
  } finally {
    conn.release();
  }
}
