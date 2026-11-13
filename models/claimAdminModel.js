// models/claimAdminModel.js
//
// Milestone 5, Day 11 — what the claims screens read.
//
// List: open urgent claims pinned to the top, then newest first. Test claims
// (from allowlisted numbers or imported test policies, D14) are hidden unless
// asked for. Drafts and abandoned claims are not "claims" to a handler — they
// appear only when filtered for explicitly. WhatsApp numbers are masked in the
// list and shown in full on the detail only.
//
import crypto from "crypto";
import getPool from "../utils/db.js";
import { getMasterKey } from "../utils/appCrypto.js";

function parseJson(raw, fallback) {
  if (raw == null || raw === "") return fallback;
  if (typeof raw === "object") return raw;
  try { return JSON.parse(raw); } catch { return fallback; }
}

export const maskWa = (n) => {
  const d = String(n || "").replace(/\D/g, "");
  return d.length > 4 ? `••••${d.slice(-4)}` : d ? "••••" : "";
};

const STATUSES = ["draft", "submitted", "under_review", "closed", "abandoned"];
const PRIORITIES = ["normal", "high", "urgent"];

export async function listClaims({
  status = null, priority = null, category = null, q = "", includeTest = false, from = null, to = null, page = 1, limit = 25,
} = {}) {
  const where = [];
  const params = [];
  const statuses = String(status || "").split(",").filter((s) => STATUSES.includes(s));
  if (statuses.length) {
    where.push(`c.status IN (${statuses.map(() => "?").join(",")})`);
    params.push(...statuses);
  } else {
    where.push(`c.status IN ('submitted','under_review','closed')`);
  }
  if (PRIORITIES.includes(priority)) { where.push("c.priority = ?"); params.push(priority); }
  if (category) { where.push("(c.category_code = ? OR c.subcategory_code = ?)"); params.push(category, category); }
  if (!includeTest || includeTest === "false") where.push("c.is_test = 0");
  if (from) { where.push("c.submitted_at >= ?"); params.push(`${String(from).slice(0, 10)} 00:00:00`); }
  if (to) { where.push("c.submitted_at <= ?"); params.push(`${String(to).slice(0, 10)} 23:59:59`); }
  const term = String(q || "").trim();
  if (term) {
    const like = `%${term.replace(/[%_\\]/g, "\\$&")}%`;
    const digits = term.replace(/\D/g, "");
    where.push(`(c.reference LIKE ? OR c.policy_number LIKE ? OR c.holder_name LIKE ?${digits.length >= 4 ? " OR c.wa_number LIKE ?" : ""})`);
    params.push(like, like, like);
    if (digits.length >= 4) params.push(`%${digits}`);
  }
  const lim = Math.min(100, Math.max(1, Number(limit) || 25));
  const off = (Math.max(1, Number(page) || 1) - 1) * lim;
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const pool = getPool();
  const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total FROM claims c ${whereSql}`, params);
  const [rows] = await pool.query(
    `SELECT c.id, c.reference, c.status, c.priority, c.policy_number, c.holder_name, c.wa_number, c.language,
            c.category_code, c.subcategory_code, c.incident_date, c.incident_country, c.incident_city,
            c.flags, c.is_test, c.submitted_at, c.created_at, c.updated_at,
            cat.name_fr AS category_fr, cat.name_en AS category_en, sub.name_fr AS subcategory_fr, sub.name_en AS subcategory_en,
            (SELECT COUNT(*) FROM claim_documents d WHERE d.claim_id = c.id AND d.status IN ('stored','pending')) AS documents
       FROM claims c
       LEFT JOIN claim_categories cat ON cat.code = c.category_code
       LEFT JOIN claim_categories sub ON sub.code = c.subcategory_code
       ${whereSql}
      ORDER BY (c.priority = 'urgent' AND c.status IN ('submitted','under_review')) DESC,
               COALESCE(c.submitted_at, c.created_at) DESC, c.id DESC
      LIMIT ? OFFSET ?`,
    [...params, lim, off]
  );
  return {
    total: Number(total),
    page: Math.max(1, Number(page) || 1),
    limit: lim,
    claims: rows.map((r) => ({
      id: r.id,
      reference: r.reference,
      status: r.status,
      priority: r.priority,
      urgentOpen: r.priority === "urgent" && ["submitted", "under_review"].includes(r.status),
      policyNumber: r.policy_number,
      holderName: r.holder_name,
      waNumber: maskWa(r.wa_number),
      language: r.language,
      category: { code: r.category_code, fr: r.category_fr, en: r.category_en },
      subcategory: { code: r.subcategory_code, fr: r.subcategory_fr, en: r.subcategory_en },
      incidentDate: r.incident_date,
      place: [r.incident_city, r.incident_country].filter(Boolean).join(", "),
      flags: parseJson(r.flags, []),
      isTest: Boolean(Number(r.is_test)),
      documents: Number(r.documents || 0),
      submittedAt: r.submitted_at,
      createdAt: r.created_at,
    })),
  };
}

export async function claimsSummary() {
  const [rows] = await getPool().query(
    `SELECT status, is_test, priority, COUNT(*) AS n FROM claims GROUP BY status, is_test, priority`
  );
  const out = { submitted: 0, under_review: 0, closed: 0, urgentOpen: 0, test: 0, drafts: 0, abandoned: 0 };
  for (const r of rows) {
    const n = Number(r.n);
    if (Number(r.is_test)) { if (r.status !== "draft" && r.status !== "abandoned") out.test += n; continue; }
    if (r.status === "draft") out.drafts += n;
    else if (r.status === "abandoned") out.abandoned += n;
    else out[r.status] += n;
    if (r.priority === "urgent" && ["submitted", "under_review"].includes(r.status)) out.urgentOpen += n;
  }
  return out;
}

export async function getClaimDetail(id) {
  const pool = getPool();
  const [[c]] = await pool.query(
    `SELECT c.*, cat.name_fr AS category_fr, cat.name_en AS category_en, sub.name_fr AS subcategory_fr, sub.name_en AS subcategory_en,
            sub.extra_fields AS sub_fields
       FROM claims c
       LEFT JOIN claim_categories cat ON cat.code = c.category_code
       LEFT JOIN claim_categories sub ON sub.code = c.subcategory_code
      WHERE c.id = ? LIMIT 1`,
    [id]
  );
  if (!c) return null;
  const [history] = await pool.query(
    `SELECT h.id, h.from_status, h.to_status, h.changed_by, h.changed_by_user_id, u.name AS changed_by_name, h.note, h.created_at
       FROM claim_status_history h LEFT JOIN users u ON u.id = h.changed_by_user_id
      WHERE h.claim_id = ? ORDER BY h.id`,
    [id]
  );
  const [documents] = await pool.query(
    `SELECT id, wa_message_id, original_filename, detected_mime, declared_mime, size_bytes, document_type, status, failure_code, stored_at, purged_at, created_at
       FROM claim_documents WHERE claim_id = ? ORDER BY id`,
    [id]
  );
  const fieldDefs = parseJson(c.sub_fields, []);
  const values = parseJson(c.extra_fields, {});
  return {
    id: c.id,
    reference: c.reference,
    status: c.status,
    priority: c.priority,
    isTest: Boolean(Number(c.is_test)),
    language: c.language,
    waNumber: c.wa_number,
    policyNumber: c.policy_number,
    holderName: c.holder_name,
    saleId: c.sale_id,
    externalPolicyId: c.external_policy_id,
    category: { code: c.category_code, fr: c.category_fr, en: c.category_en },
    subcategory: { code: c.subcategory_code, fr: c.subcategory_fr, en: c.subcategory_en },
    incidentDate: c.incident_date,
    incidentCountry: c.incident_country,
    incidentCountryCode: c.incident_country_code,
    incidentCity: c.incident_city,
    description: c.description,
    // Each answer with the question's label, in the order the category asks them.
    extraFields: [
      ...fieldDefs.map((f) => ({ key: f.key, labelFr: f.label_fr, labelEn: f.label_en, type: f.type, value: values[f.key] ?? null })),
      ...Object.keys(values).filter((k) => !fieldDefs.some((f) => f.key === k)).map((k) => ({ key: k, labelFr: k, labelEn: k, value: values[k] })),
    ],
    flags: parseJson(c.flags, []),
    policySnapshot: parseJson(c.policy_snapshot, null),
    consentAcceptedAt: c.consent_accepted_at,
    submittedAt: c.submitted_at,
    closedAt: c.closed_at,
    abandonedAt: c.abandoned_at,
    createdAt: c.created_at,
    history,
    documents: documents.map((d) => ({
      id: d.id,
      filename: d.original_filename,
      mime: d.detected_mime || d.declared_mime,
      size: d.size_bytes,
      status: d.status,
      failureCode: d.failure_code,
      storedAt: d.stored_at,
      purgedAt: d.purged_at,
      createdAt: d.created_at,
      waMessageId: d.wa_message_id || null,
      viewable: d.status === "stored",
    })),
  };
}

/* ------------------------------------------- signed, short-lived file links */

export const LINK_TTL_SECONDS = 300;

function linkKey() {
  return crypto.createHash("sha256").update(Buffer.concat([Buffer.from("claim-document-links:v1:"), getMasterKey()])).digest();
}

export function signDocumentLink(documentId, userId, { now = Date.now(), ttl = LINK_TTL_SECONDS } = {}) {
  const exp = Math.floor(now / 1000) + ttl;
  const sig = crypto.createHmac("sha256", linkKey()).update(`${documentId}.${userId}.${exp}`).digest("hex");
  return { exp, sig, userId };
}

export function verifyDocumentLink(documentId, { u, exp, sig }, { now = Date.now() } = {}) {
  if (!u || !exp || !/^[0-9a-f]{64}$/.test(String(sig || ""))) return { ok: false, reason: "malformed" };
  if (Number(exp) < Math.floor(now / 1000)) return { ok: false, reason: "expired" };
  const expect = crypto.createHmac("sha256", linkKey()).update(`${documentId}.${u}.${exp}`).digest("hex");
  const ok = crypto.timingSafeEqual(Buffer.from(expect, "hex"), Buffer.from(String(sig), "hex"));
  return ok ? { ok: true, userId: Number(u) } : { ok: false, reason: "bad_signature" };
}
