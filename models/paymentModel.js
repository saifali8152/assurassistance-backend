// src/models/paymentModel.js
//
// Storage for payment transactions and their callback archive.
//
// THREE RULES, all learned from the WhatsApp module:
//
//   1. Archive before processing. A callback is written to payment_callbacks —
//      raw bytes, signature header, source IP — before anything interprets it.
//      In a dispute the provider's exact payload is the evidence, and a payload
//      we failed to parse is exactly the one we will need.
//
//   2. Dedupe atomically, in the database. `INSERT ... ON DUPLICATE KEY` and the
//      UNIQUE (provider, provider_tx_id) index do the work; a "SELECT then
//      INSERT" would still let two concurrent redeliveries through.
//
//   3. Serialise with a row lock, not a long transaction. A transition takes
//      SELECT ... FOR UPDATE on the one row, decides, writes, commits. No HTTP
//      call ever happens inside that window.
//
import getPool from "../utils/db.js";
import { canTransition, historyEntry, appendHistory } from "../utils/payments/stateMachine.js";
import { allocateNumber } from "../utils/documentNumbers.js";

const REFERENCE_FORMAT = "PAY-{YYYY}-{SEQ:6}";

/** A customer-quotable reference, allocated from the same sequence machinery. */
export async function allocatePaymentReference(conn) {
  return allocateNumber(conn, "payment", REFERENCE_FORMAT);
}

/**
 * Start a transaction row.
 *
 * `idempotencyKey` is ours, one per payment ATTEMPT. A customer tapping the pay
 * button twice sends the same key and gets the same row back rather than a
 * second charge, which is the single most likely way to take money twice.
 */
export async function createTransaction({
  caseId = null,
  provider,
  idempotencyKey,
  msisdn = null,
  amount,
  currency = "XOF",
  waSessionId = null,
  timeoutMinutes = 15,
}) {
  const pool = getPool();
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [existing] = await conn.query(
      `SELECT * FROM payment_transactions WHERE provider = ? AND idempotency_key = ? LIMIT 1`,
      [provider, idempotencyKey]
    );
    if (existing[0]) {
      await conn.commit();
      return { transaction: hydrate(existing[0]), duplicate: true };
    }

    const reference = await allocatePaymentReference(conn);
    const [res] = await conn.execute(
      `INSERT INTO payment_transactions
         (reference, case_id, provider, idempotency_key, msisdn, amount, currency,
          status, status_history, wa_session_id, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, DATE_ADD(NOW(), INTERVAL ? MINUTE))`,
      [
        reference,
        caseId,
        provider,
        idempotencyKey,
        msisdn,
        amount,
        currency,
        JSON.stringify([historyEntry("pending", "pending", { by: "system", note: "created" })]),
        waSessionId,
        Math.max(2, Number(timeoutMinutes) || 15),
      ]
    );
    await conn.commit();

    const row = await getTransactionById(res.insertId);
    return { transaction: row, duplicate: false };
  } catch (err) {
    try { await conn.rollback(); } catch { /* released below */ }
    // Two concurrent first attempts with one key: the index caught the loser,
    // so hand it the winner's row instead of an error.
    if (err?.code === "ER_DUP_ENTRY") {
      const existing = await getTransactionByIdempotencyKey(provider, idempotencyKey);
      if (existing) return { transaction: existing, duplicate: true };
    }
    throw err;
  } finally {
    conn.release();
  }
}

function hydrate(row) {
  if (!row) return null;
  let history = [];
  if (Array.isArray(row.status_history)) history = row.status_history;
  else if (typeof row.status_history === "string" && row.status_history.trim()) {
    try { history = JSON.parse(row.status_history); } catch { history = []; }
  }
  return { ...row, status_history: history };
}

export async function getTransactionById(id) {
  const [rows] = await getPool().query(`SELECT * FROM payment_transactions WHERE id = ? LIMIT 1`, [id]);
  return hydrate(rows[0]);
}

export async function getTransactionByReference(reference) {
  const [rows] = await getPool().query(
    `SELECT * FROM payment_transactions WHERE reference = ? LIMIT 1`, [reference]
  );
  return hydrate(rows[0]);
}

export async function getTransactionByIdempotencyKey(provider, key) {
  const [rows] = await getPool().query(
    `SELECT * FROM payment_transactions WHERE provider = ? AND idempotency_key = ? LIMIT 1`,
    [provider, key]
  );
  return hydrate(rows[0]);
}

export async function getTransactionByProviderTx(provider, providerTxId) {
  if (!providerTxId) return null;
  const [rows] = await getPool().query(
    `SELECT * FROM payment_transactions WHERE provider = ? AND provider_tx_id = ? LIMIT 1`,
    [provider, providerTxId]
  );
  return hydrate(rows[0]);
}

/**
 * Attach the provider's id once initiation returns it.
 *
 * Guarded by `provider_tx_id IS NULL` so a late or duplicate initiation cannot
 * repoint a transaction at a different provider-side payment.
 */
export async function setProviderTxId(id, providerTxId) {
  const [res] = await getPool().execute(
    `UPDATE payment_transactions SET provider_tx_id = ?
      WHERE id = ? AND provider_tx_id IS NULL`,
    [providerTxId, id]
  );
  return res.affectedRows === 1;
}

/**
 * Move a transaction to a new state, or explain why it cannot move.
 *
 * Returns `{ok:true, noop:true}` when the transaction is already in the target
 * state — which is what a provider's retried callback looks like, and is not an
 * error.
 */
export async function transition(id, to, { by = "system", note = null, failureCode = null, failureDetail = null } = {}) {
  const pool = getPool();
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [rows] = await conn.query(
      `SELECT id, status, status_history FROM payment_transactions WHERE id = ? FOR UPDATE`, [id]
    );
    const row = rows[0];
    if (!row) {
      await conn.rollback();
      return { ok: false, reason: "not_found", message: `No payment transaction ${id}` };
    }

    const from = row.status;
    const verdict = canTransition(from, to);
    if (!verdict.ok) {
      await conn.rollback();
      return { ...verdict, from, to };
    }
    if (verdict.noop) {
      await conn.rollback();
      return { ok: true, noop: true, from, to };
    }

    const history = appendHistory(row.status_history, historyEntry(from, to, { by, note }));
    const completedAt = to === "completed" ? "NOW()" : "completed_at";
    const initiatedAt = to === "initiated" ? "COALESCE(initiated_at, NOW())" : "initiated_at";

    await conn.execute(
      `UPDATE payment_transactions
          SET status = ?, failure_code = ?, failure_detail = ?, status_history = ?,
              completed_at = ${completedAt}, initiated_at = ${initiatedAt}
        WHERE id = ?`,
      [to, failureCode, failureDetail, JSON.stringify(history), id]
    );
    await conn.commit();
    return { ok: true, from, to };
  } catch (err) {
    try { await conn.rollback(); } catch { /* released below */ }
    throw err;
  } finally {
    conn.release();
  }
}

/** Link the issued policy back to the payment that bought it. */
export async function attachSale(id, saleId) {
  const [res] = await getPool().execute(
    `UPDATE payment_transactions SET sale_id = ? WHERE id = ? AND sale_id IS NULL`,
    [saleId, id]
  );
  return res.affectedRows === 1;
}

/* ------------------------------------------------------------- callbacks */

/**
 * Archive a callback exactly as it arrived, before anything reads it.
 *
 * `duplicate` is decided here rather than by the caller: it is the first time
 * we have both the provider and its transaction id in one place, and deciding
 * it atomically is what stops two redeliveries both issuing a policy.
 */
export async function recordCallback({
  provider,
  rawBody,
  signatureHeader = null,
  signatureValid = false,
  providerTxId = null,
  contentType = null,
  remoteIp = null,
}) {
  const pool = getPool();
  const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody ?? ""), "utf8");

  let duplicate = false;
  if (providerTxId) {
    const [seen] = await pool.query(
      `SELECT 1 FROM payment_callbacks
        WHERE provider = ? AND provider_tx_id = ? AND processed = 1 LIMIT 1`,
      [provider, providerTxId]
    );
    duplicate = seen.length > 0;
  }

  const [res] = await pool.execute(
    `INSERT INTO payment_callbacks
       (provider, provider_tx_id, signature_header, signature_valid, raw_body,
        content_type, remote_ip, duplicate)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [provider, providerTxId, signatureHeader, signatureValid ? 1 : 0, body, contentType, remoteIp, duplicate ? 1 : 0]
  );
  return { id: res.insertId, duplicate };
}

export async function markCallbackProcessed(id, { transactionId = null, error = null } = {}) {
  await getPool().execute(
    `UPDATE payment_callbacks
        SET processed = 1, transaction_id = COALESCE(?, transaction_id), process_error = ?
      WHERE id = ?`,
    [transactionId, error ? String(error).slice(0, 500) : null, id]
  );
}

/* ---------------------------------------------------------- the sweeper */

/**
 * Transactions that have outlived their window.
 *
 * Returned oldest first and in batches, because the sweeper runs as a cron
 * script and should make steady progress rather than try to drain a backlog in
 * one pass.
 */
export async function findExpirable(limit = 100) {
  const [rows] = await getPool().query(
    `SELECT * FROM payment_transactions
      WHERE status IN ('pending','initiated','awaiting_confirmation')
        AND expires_at IS NOT NULL AND expires_at < NOW()
      ORDER BY expires_at ASC
      LIMIT ?`,
    [Math.max(1, Math.min(1000, Number(limit) || 100))]
  );
  return rows.map(hydrate);
}

/** Transactions still waiting, for the status poller. */
export async function findPending(limit = 100) {
  const [rows] = await getPool().query(
    `SELECT * FROM payment_transactions
      WHERE status IN ('initiated','awaiting_confirmation')
      ORDER BY updated_at ASC
      LIMIT ?`,
    [Math.max(1, Math.min(1000, Number(limit) || 100))]
  );
  return rows.map(hydrate);
}

/* ------------------------------------------------------------ the screen */

/**
 * Transactions for the admin list.
 *
 * Search deliberately covers the reference, the provider's own id and the
 * policy number — the three things someone has in front of them when a customer
 * calls — but NOT the payer's number: that is personal data, it is encrypted in
 * the traveller record, and a free-text search over phone numbers is the shape
 * of feature that leaks a customer list.
 */
export async function listTransactions({
  page = 1,
  limit = 25,
  status = null,
  provider = null,
  search = "",
  from = null,
  to = null,
} = {}) {
  const pool = getPool();
  const where = [];
  const params = [];

  if (status) {
    where.push("t.status = ?");
    params.push(status);
  }
  if (provider) {
    where.push("t.provider = ?");
    params.push(provider);
  }
  if (from) {
    where.push("t.created_at >= ?");
    params.push(from);
  }
  if (to) {
    where.push("t.created_at < DATE_ADD(?, INTERVAL 1 DAY)");
    params.push(to);
  }
  if (search && String(search).trim()) {
    const like = `%${String(search).trim()}%`;
    where.push("(t.reference LIKE ? OR t.provider_tx_id LIKE ? OR s.policy_number LIKE ?)");
    params.push(like, like, like);
  }

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const safeLimit = Math.max(1, Math.min(200, Number(limit) || 25));
  const offset = (Math.max(1, Number(page) || 1) - 1) * safeLimit;

  const [rows] = await pool.query(
    `SELECT t.id, t.reference, t.provider, t.provider_tx_id, t.amount, t.currency,
            t.status, t.failure_code, t.created_at, t.completed_at, t.expires_at,
            t.case_id, t.sale_id, t.wa_session_id,
            s.policy_number,
            -- Only the last four digits: enough to confirm a number with the
            -- customer on the phone, useless as a contact list.
            CONCAT('••••', RIGHT(t.msisdn, 4)) AS msisdn_masked
       FROM payment_transactions t
       LEFT JOIN sales s ON s.id = t.sale_id
       ${whereSql}
      ORDER BY t.created_at DESC
      LIMIT ? OFFSET ?`,
    [...params, safeLimit, offset]
  );

  const [[count]] = await pool.query(
    `SELECT COUNT(*) AS n
       FROM payment_transactions t
       LEFT JOIN sales s ON s.id = t.sale_id
       ${whereSql}`,
    params
  );

  return { rows, total: Number(count.n) || 0, page: Number(page) || 1, limit: safeLimit };
}

/** Counts by status over a window, for the summary strip above the list. */
export async function transactionStats({ days = 7 } = {}) {
  const [rows] = await getPool().query(
    `SELECT status, COUNT(*) AS n, COALESCE(SUM(amount), 0) AS amount
       FROM payment_transactions
      WHERE created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
      GROUP BY status`,
    [Math.max(1, Math.min(365, Number(days) || 7))]
  );

  // The two numbers that mean something is wrong right now, rather than
  // something that merely happened.
  const [[attention]] = await getPool().query(
    `SELECT
       (SELECT COUNT(*) FROM payment_transactions
         WHERE status IN ('pending','initiated','awaiting_confirmation')
           AND expires_at < NOW())                        AS stuck,
       (SELECT COUNT(*) FROM payment_transactions
         WHERE status = 'completed' AND sale_id IS NULL)  AS paidWithoutPolicy`
  );

  return {
    days,
    byStatus: rows.map((r) => ({ status: r.status, count: Number(r.n), amount: Number(r.amount) })),
    stuck: Number(attention.stuck) || 0,
    paidWithoutPolicy: Number(attention.paidWithoutPolicy) || 0,
  };
}

/**
 * One transaction with everything an operator needs to answer "what happened".
 *
 * The callback archive is the point: in a dispute, what the provider actually
 * sent is the evidence, and `signature_valid` plus `process_error` explain a
 * payment that went nowhere far better than a status column can.
 */
export async function getTransactionDetail(id) {
  const pool = getPool();
  const [rows] = await pool.query(
    `SELECT t.*, s.policy_number, s.certificate_number, s.payment_status AS sale_payment_status
       FROM payment_transactions t
       LEFT JOIN sales s ON s.id = t.sale_id
      WHERE t.id = ? LIMIT 1`,
    [id]
  );
  const tx = hydrate(rows[0]);
  if (!tx) return null;

  const [callbacks] = await pool.query(
    `SELECT id, provider, provider_tx_id, signature_valid, processed, duplicate,
            process_error, remote_ip, content_type, received_at,
            CHAR_LENGTH(raw_body) AS body_bytes
       FROM payment_callbacks
      WHERE transaction_id = ? OR (provider = ? AND provider_tx_id = ? AND provider_tx_id IS NOT NULL)
      ORDER BY received_at ASC
      LIMIT 50`,
    [id, tx.provider, tx.provider_tx_id]
  );

  // The payer's number is masked here too. Someone diagnosing a payment needs
  // to confirm a number, not to read one off a screen.
  const masked = tx.msisdn ? `••••${String(tx.msisdn).slice(-4)}` : null;
  const { msisdn, ...safe } = tx;

  return { ...safe, msisdn_masked: masked, callbacks };
}

/** The raw bytes of one callback, for a dispute. Admin-only, audited. */
export async function getCallbackBody(callbackId) {
  const [rows] = await getPool().query(
    `SELECT id, provider, raw_body, content_type, received_at FROM payment_callbacks WHERE id = ? LIMIT 1`,
    [callbackId]
  );
  const row = rows[0];
  if (!row) return null;
  return { ...row, raw_body: Buffer.isBuffer(row.raw_body) ? row.raw_body.toString("utf8") : String(row.raw_body) };
}

export const __testables = { hydrate };
