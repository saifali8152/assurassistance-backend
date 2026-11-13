// models/claimDocumentModel.js
//
// Milestone 4, Day 5 — the rows behind claim documents.
//
// A row is written the moment a file arrives, BEFORE it is downloaded, so a
// file is never lost to a failure halfway: if Meta or the disk fails, the row
// stays `pending` with the media id and a re-fetch job tries again. Rejected
// files (wrong type, too big, corrupted) keep their row with the reason, so a
// handler can see that the customer did try to send something.
//
// A redelivered webhook carries the same Meta message id; the unique key on
// wa_message_id makes the second delivery a no-op instead of a duplicate file.
//
import getPool from "../utils/db.js";
import { downloadMetaMedia, inspectDocument, writeEncrypted } from "../utils/claims/documentStore.js";

const REFETCH_MAX_ATTEMPTS = 6;
const REFETCH_BACKOFF_MIN = [5, 15, 30, 60, 180, 360];

export async function countDocuments(claimId, conn = null) {
  const [rows] = await (conn || getPool()).query(
    `SELECT COUNT(*) AS n FROM claim_documents WHERE claim_id = ? AND status IN ('stored','pending')`,
    [claimId]
  );
  return Number(rows[0]?.n || 0);
}

export async function listDocuments(claimId) {
  const [rows] = await getPool().query(
    `SELECT id, claim_id, original_filename, declared_mime, detected_mime, size_bytes, document_type, status,
            failure_code, attempts, stored_at, purged_at, created_at
       FROM claim_documents WHERE claim_id = ? ORDER BY id`,
    [claimId]
  );
  return rows;
}

export async function getDocument(id) {
  const [rows] = await getPool().query(`SELECT * FROM claim_documents WHERE id = ? LIMIT 1`, [id]);
  return rows[0] || null;
}

function cleanName(name, fallback) {
  const n = String(name || "").replace(/[\\/\0\r\n]/g, "_").trim().slice(0, 255);
  return n || fallback;
}

/**
 * Take one file for a claim.
 *
 * @param source  { buffer } (the simulator, tests) or { mediaId } (WhatsApp)
 * @returns
 *   { ok:true, status:'stored', documentId, count }
 *   { ok:true, status:'pending', documentId, count }   ← kept, will be fetched again
 *   { ok:true, duplicate:true, documentId, count }
 *   { ok:false, code }  codes: not_draft · too_many · too_large · bad_type · corrupted · hash_mismatch · empty · media_gone …
 */
export async function ingestDocument({
  claimId, waMessageId = null, mediaId = null, buffer = null, declaredMime = null, filename = null,
  declaredSha256 = null, waConfig = {}, claimsConfig = {}, fetchImpl,
}) {
  const pool = getPool();
  const [[claim]] = await pool.query(`SELECT id, status FROM claims WHERE id = ? LIMIT 1`, [claimId]);
  if (!claim || claim.status !== "draft") return { ok: false, code: "not_draft" };

  if (waMessageId) {
    const [[dup]] = await pool.query(`SELECT id, status FROM claim_documents WHERE wa_message_id = ? LIMIT 1`, [waMessageId]);
    if (dup) return { ok: true, duplicate: true, documentId: dup.id, status: dup.status, count: await countDocuments(claimId) };
  }

  const max = Math.max(1, Number(claimsConfig.maxDocuments) || 10);
  if ((await countDocuments(claimId)) >= max) return { ok: false, code: "too_many", max };

  const maxBytes = Math.max(1, Number(claimsConfig.maxFileMb) || 10) * 1024 * 1024;
  let documentId;
  try {
    const [ins] = await pool.execute(
      `INSERT INTO claim_documents (claim_id, original_filename, declared_mime, media_id, wa_message_id, status)
       VALUES (?, ?, ?, ?, ?, 'pending')`,
      [claimId, cleanName(filename, null), declaredMime ? String(declaredMime).slice(0, 120) : null, mediaId, waMessageId]
    );
    documentId = ins.insertId;
  } catch (err) {
    if (err?.code === "ER_DUP_ENTRY" && waMessageId) {
      const [[dup]] = await pool.query(`SELECT id, status FROM claim_documents WHERE wa_message_id = ? LIMIT 1`, [waMessageId]);
      return { ok: true, duplicate: true, documentId: dup?.id, status: dup?.status, count: await countDocuments(claimId) };
    }
    throw err;
  }

  return processDocument({ documentId, claimId, mediaId, buffer, declaredSha256, waConfig, maxBytes, fetchImpl, attemptsSoFar: 0 });
}

async function processDocument({ documentId, claimId, mediaId, buffer, declaredSha256, waConfig, maxBytes, fetchImpl, attemptsSoFar }) {
  const pool = getPool();
  let bytes = buffer;
  let sha = declaredSha256;
  if (!bytes) {
    const dl = await downloadMetaMedia(mediaId, { config: waConfig, maxBytes, fetchImpl, ...(fetchImpl ? { backoffMs: [1, 1, 1] } : {}) });
    if (!dl.ok) {
      if (dl.retryable) {
        const attempts = attemptsSoFar + 1;
        const giveUp = attempts >= REFETCH_MAX_ATTEMPTS;
        await pool.execute(
          `UPDATE claim_documents SET attempts = ?, failure_code = ?, status = ?,
                  next_attempt_at = ${giveUp ? "NULL" : "NOW() + INTERVAL ? MINUTE"} WHERE id = ?`,
          giveUp ? [attempts, dl.code, "failed", documentId] : [attempts, dl.code, "pending", REFETCH_BACKOFF_MIN[attempts - 1], documentId]
        );
        return giveUp
          ? { ok: false, code: "download_failed", documentId }
          : { ok: true, status: "pending", documentId, count: await countDocuments(claimId) };
      }
      await pool.execute(
        `UPDATE claim_documents SET status = 'rejected', failure_code = ?, attempts = attempts + 1 WHERE id = ?`,
        [dl.code, documentId]
      );
      return { ok: false, code: dl.code, documentId };
    }
    bytes = dl.buffer;
    sha = sha || dl.sha256;
  }

  const verdict = await inspectDocument(bytes, { maxBytes, declaredSha256: sha });
  if (!verdict.ok) {
    await pool.execute(
      `UPDATE claim_documents SET status = 'rejected', failure_code = ?, size_bytes = ?, attempts = attempts + 1 WHERE id = ?`,
      [verdict.code, bytes?.length ?? null, documentId]
    );
    return { ok: false, code: verdict.code, documentId };
  }

  const storageKey = writeEncrypted(bytes);
  await pool.execute(
    `UPDATE claim_documents
        SET status = 'stored', storage_key = ?, detected_mime = ?, size_bytes = ?, sha256 = ?,
            stored_at = NOW(), failure_code = NULL, next_attempt_at = NULL, attempts = attempts + 1
      WHERE id = ?`,
    [storageKey, verdict.type, verdict.size, verdict.sha256, documentId]
  );
  return { ok: true, status: "stored", documentId, count: await countDocuments(claimId) };
}

/**
 * The re-fetch job: documents whose download failed for a temporary reason.
 * Works on submitted claims too — a file the customer sent must not be lost
 * because Meta was slow at that moment.
 */
export async function refetchPendingDocuments({ waConfig, claimsConfig = {}, limit = 25, fetchImpl } = {}) {
  const [rows] = await getPool().query(
    `SELECT id, claim_id, media_id, attempts FROM claim_documents
      WHERE status = 'pending' AND media_id IS NOT NULL AND (next_attempt_at IS NULL OR next_attempt_at <= NOW())
      ORDER BY id LIMIT ?`,
    [Number(limit) || 25]
  );
  const maxBytes = Math.max(1, Number(claimsConfig.maxFileMb) || 10) * 1024 * 1024;
  const out = { due: rows.length, stored: 0, pending: 0, rejected: 0, failed: 0 };
  for (const r of rows) {
    const res = await processDocument({
      documentId: r.id, claimId: r.claim_id, mediaId: r.media_id, buffer: null, declaredSha256: null,
      waConfig, maxBytes, fetchImpl, attemptsSoFar: Number(r.attempts || 0),
    });
    if (res.ok && res.status === "stored") out.stored += 1;
    else if (res.ok) out.pending += 1;
    else if (res.code === "download_failed") out.failed += 1;
    else out.rejected += 1;
  }
  return out;
}

/**
 * Retention (D9): remove the FILES of documents belonging to claims that were
 * closed or abandoned more than `retentionDays` ago. Only when the admin has
 * set a retention period — empty means keep forever. The database rows stay,
 * marked `purged` with the date, so the history still shows a file existed.
 */
export async function purgeExpiredDocuments({ retentionDays, dryRun = false, limit = 500 } = {}) {
  const days = Number(retentionDays);
  if (!Number.isFinite(days) || days <= 0) return { enabled: false, due: 0, purged: 0 };
  const [rows] = await getPool().query(
    `SELECT d.id, d.storage_key
       FROM claim_documents d
       JOIN claims c ON c.id = d.claim_id
      WHERE d.status = 'stored'
        AND c.status IN ('closed','abandoned')
        AND COALESCE(c.closed_at, c.abandoned_at) < NOW() - INTERVAL ? DAY
      ORDER BY d.id LIMIT ?`,
    [days, Number(limit) || 500]
  );
  if (dryRun) return { enabled: true, due: rows.length, purged: 0, ids: rows.map((r) => r.id) };
  const { removeStored } = await import("../utils/claims/documentStore.js");
  let purged = 0;
  for (const r of rows) {
    removeStored(r.storage_key);
    await getPool().execute(`UPDATE claim_documents SET status = 'purged', purged_at = NOW() WHERE id = ? AND status = 'stored'`, [r.id]);
    purged += 1;
  }
  return { enabled: true, due: rows.length, purged, ids: rows.map((r) => r.id) };
}
