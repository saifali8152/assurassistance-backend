// models/externalPolicyModel.js
//
// Milestone 5, Day 10 — imported policies (D13).
//
// Policies sold outside this platform, loaded so their holders can file a
// claim. They live in their own table and are NEVER sales: they do not appear
// in the ledger, commissions, partner invoices or any sales figure, because
// nothing that computes those reads this table. Test policies for production
// testing are loaded here too, marked is_test.
//
// Passports are stored like travellers' now are: encrypted, plus a keyed
// blind index for exact lookup — never in plaintext.
//
import crypto from "crypto";
import getPool from "../utils/db.js";
import { passportColumns, passportHash } from "../utils/travellerPrivacy.js";
import { validateDateLoose } from "../utils/validators.js";
import { normaliseIdentifier } from "../utils/claims/policyRules.js";

export const IMPORT_COLUMNS = [
  { key: "policy_number", required: true, fr: "Numéro de police", en: "Policy number" },
  { key: "card_number", required: false, fr: "Numéro de carte d'assistance", en: "Assistance card number" },
  { key: "holder_last_name", required: true, fr: "Nom", en: "Last name" },
  { key: "holder_first_name", required: true, fr: "Prénom", en: "First name" },
  { key: "date_of_birth", required: false, fr: "Date de naissance", en: "Date of birth" },
  { key: "passport_or_id", required: true, fr: "N° passeport / pièce", en: "Passport / ID number" },
  { key: "phone", required: false, fr: "Téléphone", en: "Phone" },
  { key: "product_name", required: false, fr: "Produit", en: "Product" },
  { key: "insurer", required: false, fr: "Assureur", en: "Insurer" },
  { key: "destination", required: false, fr: "Destination", en: "Destination" },
  { key: "start_date", required: true, fr: "Début de couverture", en: "Cover start" },
  { key: "end_date", required: true, fr: "Fin de couverture", en: "Cover end" },
  { key: "status", required: false, fr: "Statut (active/cancelled)", en: "Status (active/cancelled)" },
  { key: "payment_status", required: false, fr: "Paiement (paid/unpaid/unknown)", en: "Payment (paid/unpaid/unknown)" },
  { key: "guarantee_codes", required: false, fr: "Garanties (codes séparés par ;)", en: "Guarantees (codes separated by ;)" },
];

export const MAX_IMPORT_ROWS = 5000;

const COVERAGE_CODES = [
  "medicalEmergencies", "medicalTransport", "hospitalization", "evacuationRepatriation", "bodyRepatriation",
  "tripCancellation", "baggageDeliveryDelay", "passportLoss", "civilLiability", "legalAssistance", "bail",
];

export function templateCsv() {
  const header = IMPORT_COLUMNS.map((c) => c.key).join(",");
  const example = [
    "EXT-2026-0001", "", "KONE", "Awa", "05/05/1990", "AB1234567", "+2250700000000", "Voyage Gold", "Partner Re", "France",
    "01/11/2026", "30/11/2026", "active", "paid", "medicalEmergencies;hospitalization",
  ].join(",");
  return `${header}\n${example}\n`;
}

/** Small, strict CSV reader: quotes, escaped quotes, commas or semicolons. */
export function parseCsv(text) {
  const src = String(text || "").replace(/^﻿/, "");
  const firstLine = src.split(/\r?\n/, 1)[0] || "";
  const delim = (firstLine.match(/;/g) || []).length > (firstLine.match(/,/g) || []).length ? ";" : ",";
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') { field += '"'; i += 1; }
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === delim) { row.push(field); field = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i += 1;
      row.push(field); field = "";
      if (row.some((v) => v.trim() !== "")) rows.push(row);
      row = [];
    } else field += ch;
  }
  row.push(field);
  if (row.some((v) => v.trim() !== "")) rows.push(row);
  if (!rows.length) return [];
  const header = rows[0].map((h) => h.trim().toLowerCase().replace(/\s+/g, "_"));
  return rows.slice(1).map((r) => Object.fromEntries(header.map((h, i) => [h, (r[i] ?? "").trim()])));
}

const clean = (v, max) => {
  const s = String(v ?? "").trim();
  return s ? s.slice(0, max) : null;
};

/** Validate and normalise one row. Pure. */
export function validatePolicyRow(input) {
  const errors = {};
  const out = {};
  const policyNumber = normaliseIdentifier(input.policy_number);
  if (!policyNumber || policyNumber.length < 3) errors.policy_number = "Required";
  out.policy_number = policyNumber || null;
  out.card_number = normaliseIdentifier(input.card_number) || null;
  out.holder_last_name = clean(input.holder_last_name, 255);
  out.holder_first_name = clean(input.holder_first_name, 255);
  if (!out.holder_last_name) errors.holder_last_name = "Required";
  if (!out.holder_first_name) errors.holder_first_name = "Required";

  const passport = String(input.passport_or_id ?? "").trim();
  if (!passport || passport.replace(/[^A-Za-z0-9]/g, "").length < 4) errors.passport_or_id = "Required (at least 4 letters or digits)";
  out.passport_or_id = passport || null;

  for (const k of ["date_of_birth", "start_date", "end_date"]) {
    const raw = String(input[k] ?? "").trim();
    if (!raw) {
      if (k !== "date_of_birth") errors[k] = "Required";
      out[k] = null;
      continue;
    }
    const d = validateDateLoose(raw);
    if (!d.ok) errors[k] = "Use DD/MM/YYYY";
    out[k] = d.ok ? d.value : null;
  }
  if (out.start_date && out.end_date && out.end_date < out.start_date) errors.end_date = "Ends before it starts";

  out.phone = clean(input.phone, 50);
  out.product_name = clean(input.product_name, 255);
  out.insurer = clean(input.insurer, 120);
  out.destination = clean(input.destination, 255);

  const status = String(input.status || "active").trim().toLowerCase();
  if (!["active", "cancelled"].includes(status)) errors.status = "active or cancelled";
  out.status = status;
  const pay = String(input.payment_status || "unknown").trim().toLowerCase();
  if (!["paid", "unpaid", "unknown"].includes(pay)) errors.payment_status = "paid, unpaid or unknown";
  out.payment_status = pay;

  const codes = Array.isArray(input.guarantee_codes)
    ? input.guarantee_codes
    : String(input.guarantee_codes || "").split(/[;,|]/).map((c) => c.trim()).filter(Boolean);
  const unknown = codes.filter((c) => !COVERAGE_CODES.includes(c));
  if (unknown.length) errors.guarantee_codes = `Unknown: ${unknown.join(", ")}`;
  out.guarantee_codes = codes.length ? [...new Set(codes)] : null;

  return Object.keys(errors).length ? { ok: false, errors, value: out } : { ok: true, value: out };
}

/**
 * Check a whole file without writing anything: each row's own rules, then
 * duplicates inside the file, against imported policies, and against real
 * sales (a number that already belongs to a sale would make a claim lookup
 * ambiguous, so it is refused).
 */
export async function previewImport(rows) {
  if (!Array.isArray(rows)) return { ok: false, reason: "no_rows" };
  if (rows.length > MAX_IMPORT_ROWS) return { ok: false, reason: "too_many_rows", max: MAX_IMPORT_ROWS };
  const checked = rows.map((r, i) => ({ row: i + 2, ...validatePolicyRow(r) })); // row 1 is the header
  const seenPolicy = new Map();
  const seenCard = new Map();
  for (const c of checked) {
    const v = c.value;
    if (v.policy_number) {
      if (seenPolicy.has(v.policy_number)) (c.errors ||= {}).policy_number = `Repeated in this file (row ${seenPolicy.get(v.policy_number)})`;
      else seenPolicy.set(v.policy_number, c.row);
    }
    if (v.card_number) {
      if (seenCard.has(v.card_number)) (c.errors ||= {}).card_number = `Repeated in this file (row ${seenCard.get(v.card_number)})`;
      else seenCard.set(v.card_number, c.row);
    }
  }
  const numbers = [...seenPolicy.keys()];
  const cards = [...seenCard.keys()];
  const pool = getPool();
  const existing = new Set();
  const existingCards = new Set();
  const salesNumbers = new Set();
  for (let i = 0; i < numbers.length; i += 500) {
    const chunk = numbers.slice(i, i + 500);
    const [e] = await pool.query(`SELECT policy_number FROM external_policies WHERE policy_number IN (?)`, [chunk]);
    e.forEach((r) => existing.add(String(r.policy_number).toUpperCase()));
    const [s] = await pool.query(`SELECT policy_number FROM sales WHERE policy_number IN (?)`, [chunk]);
    s.forEach((r) => salesNumbers.add(String(r.policy_number).toUpperCase()));
  }
  for (let i = 0; i < cards.length; i += 500) {
    const [e] = await pool.query(`SELECT card_number FROM external_policies WHERE card_number IN (?)`, [cards.slice(i, i + 500)]);
    e.forEach((r) => existingCards.add(String(r.card_number).toUpperCase()));
  }
  for (const c of checked) {
    const v = c.value;
    if (v.policy_number && existing.has(v.policy_number)) (c.errors ||= {}).policy_number = "Already imported";
    if (v.policy_number && salesNumbers.has(v.policy_number)) (c.errors ||= {}).policy_number = "This number belongs to a policy sold on the platform";
    if (v.card_number && existingCards.has(v.card_number)) (c.errors ||= {}).card_number = "Already imported";
    c.ok = !c.errors || Object.keys(c.errors).length === 0;
  }
  const valid = checked.filter((c) => c.ok);
  return {
    ok: true,
    total: checked.length,
    valid: valid.length,
    invalid: checked.length - valid.length,
    errors: checked.filter((c) => !c.ok).map((c) => ({ row: c.row, policyNumber: c.value.policy_number, errors: c.errors })),
    // The preview shows the rows without the passport number.
    sample: valid.slice(0, 20).map((c) => ({ row: c.row, ...c.value, passport_or_id: c.value.passport_or_id ? `••••${String(c.value.passport_or_id).slice(-3)}` : null })),
    _rows: checked,
  };
}

/**
 * Write the valid rows of a previewed file. Invalid rows are never written;
 * the whole batch shares an import_batch_id so it can be found (and cancelled)
 * as one.
 */
export async function commitImport(rows, { isTest = false, userId = null, source = "import" } = {}) {
  const preview = await previewImport(rows);
  if (!preview.ok) return preview;
  const batchId = crypto.randomUUID();
  const conn = await getPool().getConnection();
  let inserted = 0;
  try {
    await conn.beginTransaction();
    for (const c of preview._rows.filter((r) => r.ok)) {
      const v = c.value;
      const pp = passportColumns(v.passport_or_id);
      if (!pp.passport_or_id_hash) throw Object.assign(new Error("Passport encryption is not configured"), { code: "encryption_unavailable" });
      await conn.execute(
        `INSERT INTO external_policies
           (policy_number, card_number, holder_first_name, holder_last_name, date_of_birth, passport_or_id_enc, passport_or_id_hash,
            phone, product_name, insurer, destination, start_date, end_date, status, payment_status, guarantee_codes,
            is_test, source, import_batch_id, created_by_user_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          v.policy_number, v.card_number, v.holder_first_name, v.holder_last_name, v.date_of_birth,
          pp.passport_or_id_enc, pp.passport_or_id_hash, v.phone, v.product_name, v.insurer, v.destination,
          v.start_date, v.end_date, v.status, v.payment_status, v.guarantee_codes ? JSON.stringify(v.guarantee_codes) : null,
          isTest ? 1 : 0, source, source === "import" ? batchId : null, userId,
        ]
      );
      inserted += 1;
    }
    await conn.commit();
  } catch (err) {
    await conn.rollback();
    if (err?.code === "encryption_unavailable") return { ok: false, reason: "encryption_unavailable" };
    if (err?.code === "ER_DUP_ENTRY") return { ok: false, reason: "duplicate_during_import" };
    throw err;
  } finally {
    conn.release();
  }
  const { _rows, ...summary } = preview;
  return { ...summary, inserted, batchId: source === "import" ? batchId : null };
}

const maskTail = (v, n = 4) => {
  const s = String(v || "");
  return s ? `••••${s.slice(-n)}` : null;
};

export async function listExternalPolicies({ q = "", status = null, isTest = null, page = 1, limit = 25 } = {}) {
  const where = [];
  const params = [];
  const term = String(q || "").trim();
  if (term) {
    const hash = passportHash(term);
    const like = `%${term.replace(/[%_\\]/g, "\\$&")}%`;
    where.push(`(policy_number LIKE ? OR card_number LIKE ? OR CONCAT(holder_first_name, ' ', holder_last_name) LIKE ?${hash ? " OR passport_or_id_hash = ?" : ""})`);
    params.push(like, like, like);
    if (hash) params.push(hash);
  }
  if (["active", "cancelled"].includes(status)) { where.push("status = ?"); params.push(status); }
  if (isTest === "1" || isTest === "0") { where.push("is_test = ?"); params.push(Number(isTest)); }
  const lim = Math.min(100, Math.max(1, Number(limit) || 25));
  const off = (Math.max(1, Number(page) || 1) - 1) * lim;
  const sql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const pool = getPool();
  const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total FROM external_policies ${sql}`, params);
  const [rows] = await pool.query(
    `SELECT id, policy_number, card_number, holder_first_name, holder_last_name, phone, product_name, insurer, destination,
            start_date, end_date, status, payment_status, guarantee_codes, is_test, source, import_batch_id, created_at
       FROM external_policies ${sql} ORDER BY id DESC LIMIT ? OFFSET ?`,
    [...params, lim, off]
  );
  return {
    total: Number(total),
    policies: rows.map((r) => ({ ...r, phone: maskTail(r.phone), imported: true, isTest: Boolean(Number(r.is_test)) })),
  };
}

export async function setExternalPolicyStatus(id, status) {
  if (!["active", "cancelled"].includes(status)) return { ok: false, reason: "invalid_status" };
  const [r] = await getPool().execute(`UPDATE external_policies SET status = ? WHERE id = ?`, [status, id]);
  return r.affectedRows ? { ok: true } : { ok: false, reason: "not_found" };
}
