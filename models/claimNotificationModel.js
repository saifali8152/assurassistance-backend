// models/claimNotificationModel.js
//
// The claims-team email outbox (Milestone 4, Day 6).
//
// A row is written in the same transaction that submits the claim
// (claimModel.submitClaim). This file delivers them: urgent first, retried
// with backoff, never blocking or undoing the claim. What goes in the email is
// deliberately thin — reference, type, priority, dates, place, the customer's
// own words — and NEVER the passport number or any document. The handler opens
// the admin panel for those.
//
import getPool from "../utils/db.js";

export const MAX_ATTEMPTS = 8;
/** Minutes to wait after attempt n fails (1-based). */
const BACKOFF = [2, 5, 15, 30, 60, 120, 240, 480];

function parseJson(raw, fallback) {
  if (raw == null || raw === "") return fallback;
  if (typeof raw === "object") return raw;
  try { return JSON.parse(raw); } catch { return fallback; }
}

/** Due rows with what the email needs, urgent → high → normal, oldest first. */
export async function dueNotifications({ limit = 20 } = {}) {
  const [rows] = await getPool().query(
    `SELECT n.id, n.claim_id, n.priority, n.attempts,
            c.reference, c.status, c.policy_number, c.holder_name, c.wa_number, c.language, c.is_test,
            c.incident_date, c.incident_city, c.incident_country, c.description, c.flags, c.submitted_at,
            cat.name_fr AS category_fr, cat.name_en AS category_en,
            sub.name_fr AS subcategory_fr, sub.name_en AS subcategory_en,
            (SELECT COUNT(*) FROM claim_documents d WHERE d.claim_id = c.id AND d.status = 'stored') AS documents
       FROM claim_notifications n
       JOIN claims c ON c.id = n.claim_id
       LEFT JOIN claim_categories cat ON cat.code = c.category_code
       LEFT JOIN claim_categories sub ON sub.code = c.subcategory_code
      WHERE n.status = 'pending' AND (n.next_attempt_at IS NULL OR n.next_attempt_at <= NOW())
      ORDER BY FIELD(n.priority, 'urgent', 'high', 'normal'), n.id
      LIMIT ?`,
    [Number(limit) || 20]
  );
  return rows.map((r) => ({ ...r, flags: parseJson(r.flags, []) }));
}

export async function markSent(id, sentTo) {
  await getPool().execute(
    `UPDATE claim_notifications SET status = 'sent', sent_at = NOW(), sent_to = ?, attempts = attempts + 1, last_error = NULL WHERE id = ?`,
    [String(sentTo || "").slice(0, 500), id]
  );
}

export async function markSkipped(id, reason) {
  await getPool().execute(
    `UPDATE claim_notifications SET status = 'skipped', last_error = ? WHERE id = ? AND status = 'pending'`,
    [String(reason || "").slice(0, 500), id]
  );
}

/** A failed send: try again later, or give up after MAX_ATTEMPTS (the claim is unaffected). */
export async function markFailed(id, attemptsSoFar, error) {
  const attempts = Number(attemptsSoFar || 0) + 1;
  const giveUp = attempts >= MAX_ATTEMPTS;
  const wait = BACKOFF[Math.min(attempts, BACKOFF.length) - 1];
  await getPool().execute(
    `UPDATE claim_notifications
        SET attempts = ?, last_error = ?, status = ?, next_attempt_at = ${giveUp ? "NULL" : "NOW() + INTERVAL ? MINUTE"}
      WHERE id = ?`,
    giveUp
      ? [attempts, String(error || "").slice(0, 500), "failed", id]
      : [attempts, String(error || "").slice(0, 500), "pending", wait, id]
  );
  return { attempts, giveUp, retryInMinutes: giveUp ? null : wait };
}

const PRIORITY_LABEL = { urgent: "URGENT", high: "High", normal: "Normal" };

/**
 * The email. English and French side by side would be noise; the claims
 * team's language is French, so the labels are French with the customer's
 * text as they wrote it.
 */
export function renderClaimEmail(n, { adminUrl = "" } = {}) {
  const test = Number(n.is_test) ? "[TEST] " : "";
  const pri = n.priority === "urgent" ? "[URGENT] " : n.priority === "high" ? "[Prioritaire] " : "";
  const type = [n.category_fr, n.subcategory_fr].filter(Boolean).join(" › ") || "—";
  const date = n.incident_date ? new Date(n.incident_date).toISOString().slice(0, 10) : "—";
  const place = [n.incident_city, n.incident_country].filter(Boolean).join(", ") || "—";
  const flags = (n.flags || []).length ? n.flags.join(", ") : "—";
  const description = String(n.description || "—");
  const subject = `${test}${pri}Nouveau sinistre ${n.reference} — ${n.subcategory_fr || n.category_fr || ""}`.trim();
  const lines = [
    `${test}Nouveau sinistre déclaré sur WhatsApp`,
    "",
    `Référence :      ${n.reference}`,
    `Priorité :       ${PRIORITY_LABEL[n.priority] || n.priority}`,
    `Type :           ${type}`,
    `Police :         ${n.policy_number || "—"}`,
    `Assuré :         ${n.holder_name || "—"}`,
    `Date incident :  ${date}`,
    `Lieu :           ${place}`,
    `Justificatifs :  ${n.documents || 0}`,
    `Alertes :        ${flags}`,
    "",
    "Description du client :",
    description.length > 1500 ? `${description.slice(0, 1500)}…` : description,
    "",
    adminUrl ? `Ouvrir le dossier : ${adminUrl.replace(/\/$/, "")}/claims/${n.claim_id}` : "Ouvrez le dossier dans le panneau d'administration.",
    "",
    "Les pièces justificatives et les données d'identité ne sont jamais envoyées par e-mail.",
  ];
  return { subject, text: lines.join("\n") };
}
