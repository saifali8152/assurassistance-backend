// src/utils/documentNumbers.js
//
// Atomic policy / invoice / certificate numbering.
//
// These used to be `POL-${Date.now()}` against a UNIQUE column with no retry,
// so two confirmations in the same millisecond produced an unhandled duplicate
// -key error with the first row possibly already written. Under concurrent
// mobile-money payments that stops being a rare race.
//
// Allocation is one statement:
//
//   INSERT INTO policy_sequences (seq_key, period, current_value)
//        VALUES (?, ?, LAST_INSERT_ID(1))
//   ON DUPLICATE KEY UPDATE current_value = LAST_INSERT_ID(current_value + 1)
//
// LAST_INSERT_ID(expr) sets the session value and returns it, so the INSERT
// branch yields 1 and the UPDATE branch yields current + 1. InnoDB holds a row
// lock for the duration, which makes the increment atomic without a SELECT ...
// FOR UPDATE round trip. The caller must pass the SAME connection to the
// follow-up SELECT, because LAST_INSERT_ID() is per-session — passing the pool
// would read another connection's value.
//
// The format is an operator setting, not a constant: the insurer's prefix and
// any regulatory sequence rule are theirs, and changing one must not need a
// deploy.
//
const SEQ_TOKEN = /\{SEQ:(\d{1,2})\}/;
const MAX_PAD = 12;

/** Two digits, no locale involvement. */
const pad2 = (n) => String(n).padStart(2, "0");

/**
 * Which counter a format draws from. A format that prints the year restarts
 * each year, one that prints the month restarts each month, and one that prints
 * neither counts forever.
 */
export function periodFor(format, now = new Date()) {
  const f = String(format || "");
  const year = now.getFullYear();
  if (f.includes("{MM}")) return `${year}-${pad2(now.getMonth() + 1)}`;
  if (f.includes("{YYYY}") || f.includes("{YY}")) return String(year);
  return "ALL";
}

/**
 * Reject a format before it reaches the database, so a typo in the admin screen
 * cannot mint a number with no sequence in it and collide on every row.
 */
export function validateFormat(format) {
  const f = String(format || "").trim();
  if (!f) return { ok: false, message: "A number format is required" };
  if (f.length > 60) return { ok: false, message: "Format must be 60 characters or fewer" };
  const m = f.match(SEQ_TOKEN);
  if (!m) return { ok: false, message: "Format must contain a sequence token, e.g. {SEQ:6}" };
  const width = Number(m[1]);
  if (!Number.isInteger(width) || width < 1 || width > MAX_PAD) {
    return { ok: false, message: `Sequence width must be between 1 and ${MAX_PAD}` };
  }
  const leftover = f.replace(SEQ_TOKEN, "").replace(/\{YYYY\}|\{YY\}|\{MM\}/g, "");
  if (/[{}]/.test(leftover)) {
    return { ok: false, message: "Unknown token. Supported: {YYYY} {YY} {MM} {SEQ:n}" };
  }
  return { ok: true, width };
}

/** Render a format for one allocated sequence value. Pure — tested directly. */
export function renderFormat(format, seq, now = new Date()) {
  const check = validateFormat(format);
  if (!check.ok) throw new Error(`Invalid number format: ${check.message}`);
  const year = now.getFullYear();
  // A sequence that outgrows its padding keeps counting rather than wrapping:
  // a wider number is ugly, a wrapped one is a duplicate.
  const seqText = String(seq).padStart(check.width, "0");
  return String(format)
    .replace(/\{YYYY\}/g, String(year))
    .replace(/\{YY\}/g, pad2(year % 100))
    .replace(/\{MM\}/g, pad2(now.getMonth() + 1))
    .replace(SEQ_TOKEN, seqText);
}

/**
 * Allocate the next value for one counter.
 *
 * `conn` must be a single connection (from pool.getConnection()), normally the
 * one already inside the caller's transaction. Allocation deliberately is NOT
 * rolled back with that transaction in spirit — a rolled-back sale simply
 * leaves a gap in the sequence, which is the correct trade: a gap is harmless,
 * a reused number is not.
 */
export async function allocateSequence(conn, seqKey, period) {
  await conn.execute(
    `INSERT INTO policy_sequences (seq_key, period, current_value)
          VALUES (?, ?, LAST_INSERT_ID(1))
     ON DUPLICATE KEY UPDATE current_value = LAST_INSERT_ID(current_value + 1)`,
    [seqKey, period]
  );
  const [rows] = await conn.query(`SELECT LAST_INSERT_ID() AS value`);
  const value = Number(rows?.[0]?.value);
  if (!Number.isFinite(value) || value < 1) {
    throw new Error(`Sequence allocation failed for ${seqKey}/${period}`);
  }
  return value;
}

/** Allocate one number from one format. */
export async function allocateNumber(conn, seqKey, format, now = new Date()) {
  const period = periodFor(format, now);
  const seq = await allocateSequence(conn, seqKey, period);
  return renderFormat(format, seq, now);
}

/**
 * The three numbers a sale needs, allocated together on one connection.
 *
 * Formats come from app_settings so the insurer can change its prefix without a
 * deploy; the defaults match the seed in migrations/m3_01_policy_sequences.sql.
 */
export async function allocateSaleNumbers(conn, formats = {}, now = new Date()) {
  const policyFormat = formats.policy || "AA-{YYYY}-{SEQ:6}";
  const invoiceFormat = formats.invoice || "INV-{YYYY}-{SEQ:6}";
  const certificateFormat = formats.certificate || "CERT-{YYYY}-{SEQ:6}";
  return {
    policyNumber: await allocateNumber(conn, "policy", policyFormat, now),
    invoiceNumber: await allocateNumber(conn, "invoice", invoiceFormat, now),
    certificateNumber: await allocateNumber(conn, "certificate", certificateFormat, now),
  };
}
