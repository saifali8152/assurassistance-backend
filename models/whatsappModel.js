// src/models/whatsappModel.js
//
// Sessions and the message archive for the WhatsApp purchase flow.
//
// TWO CORRECTNESS PROBLEMS THIS FILE SOLVES
//
// 1. Meta re-delivers a webhook if we are slow to answer, and a customer can
//    fire three messages in two seconds. Both would corrupt a conversation that
//    advances one step per message. Deduplication is handled by the UNIQUE index
//    on `wa_message_id` (recordInboundMessage reports a duplicate instead of
//    inserting twice), and ordering is handled by withNumberLock().
//
// 2. withNumberLock uses MySQL's advisory locks (GET_LOCK) rather than a
//    transaction with SELECT ... FOR UPDATE, because processing a step involves
//    outbound HTTP calls to Meta. Holding a write transaction open across a
//    network round-trip is how connection pools die. An advisory lock gives us
//    mutual exclusion per phone number without pinning a transaction.
//
import getPool from "../utils/db.js";

/* -------------------------------------------------------------- locking */

const LOCK_PREFIX = "aas_wa";
const LOCK_TIMEOUT_SECONDS = 8;

/**
 * Run `fn` while holding an exclusive lock on one phone number.
 *
 * Returns { ran: false } when the lock could not be acquired in time, which the
 * webhook treats as "another worker is already handling this customer" — the
 * message is archived and dropped rather than processed out of order.
 */
export async function withNumberLock(waNumber, fn) {
  const pool = getPool();
  const conn = await pool.getConnection();
  const lockName = `${LOCK_PREFIX}:${String(waNumber).replace(/\D/g, "")}`;
  let acquired = false;

  try {
    const [rows] = await conn.query("SELECT GET_LOCK(?, ?) AS got", [lockName, LOCK_TIMEOUT_SECONDS]);
    acquired = Number(rows?.[0]?.got) === 1;
    if (!acquired) return { ran: false, result: null };
    const result = await fn();
    return { ran: true, result };
  } finally {
    if (acquired) {
      // Must be released on the SAME connection that took it.
      await conn.query("SELECT RELEASE_LOCK(?)", [lockName]).catch(() => {});
    }
    conn.release();
  }
}

/* -------------------------------------------------------------- sessions */

function mapSession(row) {
  if (!row) return null;
  return {
    id: row.id,
    waNumber: row.wa_number,
    profileName: row.wa_profile_name,
    language: row.language,
    flowKey: row.flow_key,
    currentStep: row.current_step,
    stepHistory: parseJson(row.step_history, []),
    collectedData: parseJson(row.collected_data, {}),
    retryCount: Number(row.retry_count || 0),
    status: row.status,
    customerMessageCount: Number(row.customer_message_count || 0),
    travellerId: row.traveller_id,
    caseId: row.case_id,
    quoteReference: row.quote_reference,
    lastActivityAt: row.last_activity_at,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function parseJson(raw, fallback) {
  if (raw === null || raw === undefined) return fallback;
  if (typeof raw === "object") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

export async function getActiveSession(waNumber) {
  const pool = getPool();
  const [rows] = await pool.query(
    `SELECT * FROM whatsapp_sessions WHERE wa_number = ? AND status = 'active' LIMIT 1`,
    [waNumber]
  );
  return mapSession(rows[0]);
}

export async function getSessionById(id) {
  const pool = getPool();
  const [rows] = await pool.query(`SELECT * FROM whatsapp_sessions WHERE id = ? LIMIT 1`, [id]);
  return mapSession(rows[0]);
}

/** The most recent finished conversation, so a returning customer can resume. */
export async function getLastFinishedSession(waNumber) {
  const pool = getPool();
  const [rows] = await pool.query(
    `SELECT * FROM whatsapp_sessions
     WHERE wa_number = ? AND status <> 'active'
     ORDER BY updated_at DESC LIMIT 1`,
    [waNumber]
  );
  return mapSession(rows[0]);
}

export async function createSession({
  waNumber,
  profileName = null,
  language = "fr",
  flowKey = "purchase",
  currentStep = null,
  collectedData = {},
  timeoutHours = 24,
}) {
  const pool = getPool();
  const [result] = await pool.execute(
    `INSERT INTO whatsapp_sessions
       (wa_number, wa_profile_name, language, flow_key, current_step, collected_data,
        status, last_activity_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, 'active', NOW(), DATE_ADD(NOW(), INTERVAL ? HOUR))`,
    [waNumber, profileName, language, flowKey, currentStep, JSON.stringify(collectedData || {}), timeoutHours]
  );
  return getSessionById(result.insertId);
}

/**
 * Patch a session. Only the fields passed are written, so a step handler can
 * advance the step without having to restate the whole row.
 */
export async function updateSession(id, patch = {}) {
  const map = {
    profileName: "wa_profile_name",
    language: "language",
    flowKey: "flow_key",
    currentStep: "current_step",
    stepHistory: "step_history",
    collectedData: "collected_data",
    retryCount: "retry_count",
    status: "status",
    customerMessageCount: "customer_message_count",
    travellerId: "traveller_id",
    caseId: "case_id",
    quoteReference: "quote_reference",
    paymentTransactionId: "payment_transaction_id",
  };

  const sets = [];
  const params = [];
  for (const [key, column] of Object.entries(map)) {
    if (!(key in patch)) continue;
    let value = patch[key];
    if (key === "stepHistory" || key === "collectedData") value = JSON.stringify(value ?? (key === "stepHistory" ? [] : {}));
    sets.push(`${column} = ?`);
    params.push(value);
  }

  // Any write is activity: push the expiry window out from now.
  sets.push("last_activity_at = NOW()");
  if (patch.timeoutHours !== undefined) {
    sets.push("expires_at = DATE_ADD(NOW(), INTERVAL ? HOUR)");
    params.push(Number(patch.timeoutHours) || 24);
  }

  if (!sets.length) return getSessionById(id);
  const pool = getPool();
  await pool.execute(`UPDATE whatsapp_sessions SET ${sets.join(", ")} WHERE id = ?`, [...params, id]);
  return getSessionById(id);
}

/**
 * When the customer last wrote to us.
 *
 * Meta only allows free-form messages within 24 hours of that moment; after it
 * passes, anything the business starts must be an approved template. Read from
 * the message archive rather than `last_activity_at`, which our own outbound
 * writes also push forward and would therefore keep the window open forever.
 */
export async function getLastInboundAt(sessionId) {
  const pool = getPool();
  const [rows] = await pool.query(
    `SELECT MAX(created_at) AS last_inbound
       FROM whatsapp_messages
      WHERE session_id = ? AND direction = 'inbound'`,
    [sessionId]
  );
  return rows[0]?.last_inbound || null;
}

/**
 * How many messages of one kind we have already sent to a number recently.
 *
 * Exists so that asking for the certificate again cannot be turned into a way to
 * make us send the same document over and over — each one costs a billable Meta
 * message. Counted by NUMBER rather than by session, because the customer may be
 * on a new conversation by the time they ask.
 *
 * Failed sends do not count: if the document did not arrive, asking again is the
 * right thing to do.
 */
export async function countRecentOutboundByStep(waNumber, stepKey, minutes = 5) {
  const pool = getPool();
  const window = Math.max(1, Math.min(1440, Number(minutes) || 5));
  const [rows] = await pool.query(
    `SELECT COUNT(*) AS n
       FROM whatsapp_messages
      WHERE wa_number = ?
        AND direction = 'outbound'
        AND step_key = ?
        AND (status IS NULL OR status <> 'failed')
        AND created_at > (NOW() - INTERVAL ? MINUTE)`,
    [String(waNumber || ""), String(stepKey || ""), window]
  );
  return Number(rows[0]?.n || 0);
}

export async function incrementCustomerMessageCount(id) {
  const pool = getPool();
  await pool.execute(
    `UPDATE whatsapp_sessions SET customer_message_count = customer_message_count + 1 WHERE id = ?`,
    [id]
  );
}

export async function closeSession(id, status = "completed") {
  return updateSession(id, { status });
}

/**
 * Expire conversations past their window.
 *
 * Deliberately an UPDATE, never a DELETE: an expired conversation is still
 * evidence of what a customer was told, and the customer may want to resume it.
 */
export async function expireStaleSessions() {
  const pool = getPool();
  const [result] = await pool.execute(
    `UPDATE whatsapp_sessions
     SET status = 'expired'
     WHERE status = 'active' AND expires_at IS NOT NULL AND expires_at < NOW()`
  );
  return result.affectedRows;
}

/** Sessions for the admin screen and the 3rd-party API. */
export async function listSessions({ page = 1, limit = 25, status = null, search = "" } = {}) {
  const pool = getPool();
  const size = Math.min(100, Math.max(1, Number(limit) || 25));
  const offset = (Math.max(1, Number(page) || 1) - 1) * size;

  const where = [];
  const params = [];
  if (status) {
    where.push("s.status = ?");
    params.push(status);
  }
  if (search) {
    where.push("(s.wa_number LIKE ? OR s.wa_profile_name LIKE ? OR s.quote_reference LIKE ?)");
    const like = `%${search}%`;
    params.push(like, like, like);
  }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const [rows] = await pool.query(
    `SELECT s.*, (SELECT COUNT(*) FROM whatsapp_messages m WHERE m.session_id = s.id) AS message_total
     FROM whatsapp_sessions s
     ${whereSql}
     ORDER BY s.last_activity_at DESC
     LIMIT ${size} OFFSET ${offset}`,
    params
  );
  const [countRows] = await pool.query(
    `SELECT COUNT(*) AS total FROM whatsapp_sessions s ${whereSql}`,
    params
  );

  return {
    sessions: rows.map((r) => ({ ...mapSession(r), messageTotal: Number(r.message_total || 0) })),
    pagination: {
      page: Math.max(1, Number(page) || 1),
      limit: size,
      total: Number(countRows[0]?.total || 0),
      pages: Math.max(1, Math.ceil(Number(countRows[0]?.total || 0) / size)),
    },
  };
}

/* -------------------------------------------------------------- messages */

function mapMessage(row) {
  return {
    id: row.id,
    sessionId: row.session_id,
    waNumber: row.wa_number,
    direction: row.direction,
    waMessageId: row.wa_message_id,
    messageType: row.message_type,
    body: row.body,
    payload: parseJson(row.payload, null),
    stepKey: row.step_key,
    status: row.status,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    createdAt: row.created_at,
  };
}

/**
 * Archive an inbound message.
 *
 * Returns { duplicate: true } when Meta has already delivered this message id.
 * INSERT IGNORE against the UNIQUE index makes the check atomic — a "SELECT then
 * INSERT" would still let two concurrent deliveries through.
 */
export async function recordInboundMessage({
  sessionId = null,
  waNumber,
  waMessageId = null,
  messageType = "text",
  body = null,
  payload = null,
  stepKey = null,
}) {
  const pool = getPool();
  const [result] = await pool.execute(
    `INSERT IGNORE INTO whatsapp_messages
       (session_id, wa_number, direction, wa_message_id, message_type, body, payload, step_key, status)
     VALUES (?, ?, 'inbound', ?, ?, ?, ?, ?, 'received')`,
    [sessionId, waNumber, waMessageId, messageType, truncate(body, 60000), payload ? JSON.stringify(payload) : null, stepKey]
  );
  if (result.affectedRows === 0) return { duplicate: true, id: null };
  return { duplicate: false, id: result.insertId };
}

export async function recordOutboundMessage({
  sessionId = null,
  waNumber,
  messageType = "text",
  body = null,
  payload = null,
  stepKey = null,
  status = "queued",
}) {
  const pool = getPool();
  const [result] = await pool.execute(
    `INSERT INTO whatsapp_messages
       (session_id, wa_number, direction, message_type, body, payload, step_key, status)
     VALUES (?, ?, 'outbound', ?, ?, ?, ?, ?)`,
    [sessionId, waNumber, messageType, truncate(body, 60000), payload ? JSON.stringify(payload) : null, stepKey, status]
  );
  return result.insertId;
}

export async function markOutboundSent(id, waMessageId) {
  const pool = getPool();
  await pool.execute(
    `UPDATE whatsapp_messages SET wa_message_id = ?, status = 'sent' WHERE id = ?`,
    [waMessageId, id]
  );
}

export async function markOutboundFailed(id, errorCode, errorMessage) {
  const pool = getPool();
  await pool.execute(
    `UPDATE whatsapp_messages SET status = 'failed', error_code = ?, error_message = ? WHERE id = ?`,
    [truncate(String(errorCode ?? ""), 40) || null, truncate(String(errorMessage ?? ""), 500) || null, id]
  );
}

/** Delivery receipts from Meta (sent → delivered → read, or failed). */
export async function applyStatusUpdate({ waMessageId, status, errorCode = null, errorMessage = null }) {
  if (!waMessageId) return false;
  const pool = getPool();
  const [result] = await pool.execute(
    `UPDATE whatsapp_messages
     SET status = ?, error_code = COALESCE(?, error_code), error_message = COALESCE(?, error_message)
     WHERE wa_message_id = ?`,
    [status, errorCode, truncate(errorMessage, 500), waMessageId]
  );
  return result.affectedRows > 0;
}

export async function listSessionMessages(sessionId, { limit = 200 } = {}) {
  const pool = getPool();
  const size = Math.min(500, Math.max(1, Number(limit) || 200));
  const [rows] = await pool.query(
    `SELECT * FROM whatsapp_messages WHERE session_id = ? ORDER BY id ASC LIMIT ${size}`,
    [sessionId]
  );
  return rows.map(mapMessage);
}

export async function listMessagesByNumber(waNumber, { limit = 100 } = {}) {
  const pool = getPool();
  const size = Math.min(500, Math.max(1, Number(limit) || 100));
  const [rows] = await pool.query(
    `SELECT * FROM whatsapp_messages WHERE wa_number = ? ORDER BY id DESC LIMIT ${size}`,
    [waNumber]
  );
  return rows.map(mapMessage).reverse();
}

/**
 * Retention: transcripts contain personal data, so they do not live forever.
 *
 * This is the ONE place in the module that deletes anything, it is driven by the
 * superadmin's retention setting, and it only ever touches `whatsapp_messages` —
 * never a session, a case, a traveller or a sale.
 */
export async function pruneOldMessages(retentionDays) {
  const days = Math.max(7, Number(retentionDays) || 180);
  const pool = getPool();
  const [result] = await pool.execute(
    `DELETE FROM whatsapp_messages WHERE created_at < DATE_SUB(NOW(), INTERVAL ? DAY)`,
    [days]
  );
  return result.affectedRows;
}

/** Message-count instrumentation against the message budget (8–11; see getStats). */
export async function getMessageCountStats({ days = 30 } = {}) {
  const pool = getPool();
  const [rows] = await pool.query(
    `SELECT COUNT(*) AS completed_sessions,
            AVG(customer_message_count) AS avg_customer_messages,
            MIN(customer_message_count) AS min_customer_messages,
            MAX(customer_message_count) AS max_customer_messages
     FROM whatsapp_sessions
     WHERE status = 'completed' AND updated_at >= DATE_SUB(NOW(), INTERVAL ? DAY)`,
    [Math.max(1, Number(days) || 30)]
  );
  const r = rows[0] || {};
  return {
    windowDays: Math.max(1, Number(days) || 30),
    completedSessions: Number(r.completed_sessions || 0),
    averageCustomerMessages: r.avg_customer_messages != null ? Number(Number(r.avg_customer_messages).toFixed(2)) : null,
    minCustomerMessages: r.min_customer_messages != null ? Number(r.min_customer_messages) : null,
    maxCustomerMessages: r.max_customer_messages != null ? Number(r.max_customer_messages) : null,
  };
}

function truncate(s, max) {
  if (s === null || s === undefined) return null;
  const str = String(s);
  return str.length > max ? str.slice(0, max) : str;
}
