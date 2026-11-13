// src/utils/featureFlags.js
//
// Feature flags with an allowlist — how the claims module ships into the live
// WhatsApp number without any customer seeing it.
//
//   flagAccess('claims_enabled', waNumber)
//     → { enabled, allowlisted, allowed }
//
// `allowed` is the only thing an entry point should look at: the feature is on,
// or this number is one of the client's own test numbers.
//
// CACHING. Every inbound message checks the flag, so it is cached — but for 10
// seconds, not 30 like settings, because this is the switch the client flips
// when something is wrong and expects to take effect now. A change through
// setFlag() clears the cache of the process that made it at once; other PM2
// workers, if any, follow within the TTL. Nobody restarts anything.
//
// FAILING SAFE. If the flag cannot be read — table missing because the
// migration has not run, database hiccup — the answer is OFF. A feature that
// should be hidden must never appear because of an error.
//
import getPool from "./db.js";

const TTL_MS = 10_000;

const flagCache = new Map(); // key -> { enabled, at }
const listCache = new Map(); // key -> { numbers: Set, at }

/** Digits only. The allowlist matches exactly, never on a suffix. */
export function normaliseNumber(value) {
  return String(value || "").replace(/\D/g, "");
}

export function maskNumber(value) {
  const d = normaliseNumber(value);
  return d.length > 4 ? `${"•".repeat(Math.min(6, d.length - 4))}${d.slice(-4)}` : "••••";
}

export function clearFlagCache(key = null) {
  if (key) {
    flagCache.delete(key);
    listCache.delete(key);
  } else {
    flagCache.clear();
    listCache.clear();
  }
}

export async function isFlagEnabled(key, { pool = null } = {}) {
  const hit = flagCache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.enabled;
  let enabled = false;
  try {
    const [rows] = await (pool || getPool()).query(
      `SELECT enabled FROM feature_flags WHERE flag_key = ? LIMIT 1`,
      [key]
    );
    enabled = Boolean(Number(rows[0]?.enabled));
  } catch {
    enabled = false; // fail closed
  }
  flagCache.set(key, { enabled, at: Date.now() });
  return enabled;
}

async function allowlistFor(key, pool) {
  const hit = listCache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.numbers;
  let numbers = new Set();
  try {
    const [rows] = await (pool || getPool()).query(
      `SELECT wa_number FROM feature_flag_allowlist WHERE flag_key = ?`,
      [key]
    );
    numbers = new Set(rows.map((r) => normaliseNumber(r.wa_number)));
  } catch {
    numbers = new Set();
  }
  listCache.set(key, { numbers, at: Date.now() });
  return numbers;
}

/**
 * Can this number use this feature right now?
 * `allowlisted` is reported even when the feature is on, because a claim filed
 * from an allowlisted number is a TEST claim and is marked as one.
 */
export async function flagAccess(key, waNumber, { pool = null } = {}) {
  const [enabled, numbers] = await Promise.all([isFlagEnabled(key, { pool }), allowlistFor(key, pool)]);
  const digits = normaliseNumber(waNumber);
  const allowlisted = Boolean(digits) && numbers.has(digits);
  return { enabled, allowlisted, allowed: enabled || allowlisted };
}

/** Full state for the admin activation panel. */
export async function getFlag(key, { pool = null } = {}) {
  const [rows] = await (pool || getPool()).query(
    `SELECT f.flag_key, f.enabled, f.description, f.updated_at, f.updated_by_user_id, u.name AS updated_by_name
       FROM feature_flags f
       LEFT JOIN users u ON u.id = f.updated_by_user_id
      WHERE f.flag_key = ? LIMIT 1`,
    [key]
  );
  const row = rows[0];
  if (!row) return null;
  return {
    key: row.flag_key,
    enabled: Boolean(Number(row.enabled)),
    description: row.description,
    updatedAt: row.updated_at,
    updatedBy: row.updated_by_user_id ? { id: row.updated_by_user_id, name: row.updated_by_name || null } : null,
  };
}

/**
 * Turn a flag on or off. Audited, in one transaction with the change.
 * Setting it to the value it already has is a no-op and writes no audit row —
 * a double click is not two decisions.
 */
export async function setFlag(key, enabled, { userId = null, ip = null, pool = null } = {}) {
  const conn = await (pool || getPool()).getConnection();
  try {
    await conn.beginTransaction();
    const [rows] = await conn.query(
      `SELECT enabled FROM feature_flags WHERE flag_key = ? FOR UPDATE`,
      [key]
    );
    if (!rows[0]) {
      await conn.rollback();
      return { ok: false, reason: "unknown_flag" };
    }
    const old = Boolean(Number(rows[0].enabled));
    const next = Boolean(enabled);
    if (old === next) {
      await conn.commit();
      return { ok: true, changed: false, enabled: next };
    }
    await conn.execute(
      `UPDATE feature_flags SET enabled = ?, updated_by_user_id = ? WHERE flag_key = ?`,
      [next ? 1 : 0, userId, key]
    );
    await conn.execute(
      `INSERT INTO feature_flag_audit (flag_key, action, old_value, new_value, changed_by_user_id, ip)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [key, next ? "enable" : "disable", old ? 1 : 0, next ? 1 : 0, userId, ip]
    );
    await conn.commit();
    clearFlagCache(key);
    return { ok: true, changed: true, enabled: next };
  } catch (err) {
    try { await conn.rollback(); } catch { /* released below */ }
    throw err;
  } finally {
    conn.release();
  }
}

export async function listAllowlist(key, { pool = null } = {}) {
  const [rows] = await (pool || getPool()).query(
    `SELECT a.id, a.wa_number, a.label, a.created_at, a.added_by_user_id, u.name AS added_by_name
       FROM feature_flag_allowlist a
       LEFT JOIN users u ON u.id = a.added_by_user_id
      WHERE a.flag_key = ?
      ORDER BY a.created_at DESC`,
    [key]
  );
  return rows.map((r) => ({
    id: r.id,
    waNumber: r.wa_number,
    label: r.label,
    createdAt: r.created_at,
    addedBy: r.added_by_user_id ? { id: r.added_by_user_id, name: r.added_by_name || null } : null,
  }));
}

export async function addToAllowlist(key, waNumber, { label = null, userId = null, ip = null, pool = null } = {}) {
  const digits = normaliseNumber(waNumber);
  if (digits.length < 8 || digits.length > 15) return { ok: false, reason: "invalid_number" };
  const conn = await (pool || getPool()).getConnection();
  try {
    await conn.beginTransaction();
    const [flag] = await conn.query(`SELECT flag_key FROM feature_flags WHERE flag_key = ?`, [key]);
    if (!flag[0]) {
      await conn.rollback();
      return { ok: false, reason: "unknown_flag" };
    }
    const [res] = await conn.execute(
      `INSERT IGNORE INTO feature_flag_allowlist (flag_key, wa_number, label, added_by_user_id) VALUES (?, ?, ?, ?)`,
      [key, digits, label ? String(label).slice(0, 120) : null, userId]
    );
    if (res.affectedRows) {
      await conn.execute(
        `INSERT INTO feature_flag_audit (flag_key, action, detail, changed_by_user_id, ip) VALUES (?, 'allowlist_add', ?, ?, ?)`,
        [key, maskNumber(digits), userId, ip]
      );
    }
    await conn.commit();
    clearFlagCache(key);
    return { ok: true, added: Boolean(res.affectedRows), waNumber: digits };
  } catch (err) {
    try { await conn.rollback(); } catch { /* released below */ }
    throw err;
  } finally {
    conn.release();
  }
}

export async function removeFromAllowlist(key, waNumber, { userId = null, ip = null, pool = null } = {}) {
  const digits = normaliseNumber(waNumber);
  const conn = await (pool || getPool()).getConnection();
  try {
    await conn.beginTransaction();
    const [res] = await conn.execute(
      `DELETE FROM feature_flag_allowlist WHERE flag_key = ? AND wa_number = ?`,
      [key, digits]
    );
    if (res.affectedRows) {
      await conn.execute(
        `INSERT INTO feature_flag_audit (flag_key, action, detail, changed_by_user_id, ip) VALUES (?, 'allowlist_remove', ?, ?, ?)`,
        [key, maskNumber(digits), userId, ip]
      );
    }
    await conn.commit();
    clearFlagCache(key);
    return { ok: true, removed: Boolean(res.affectedRows) };
  } catch (err) {
    try { await conn.rollback(); } catch { /* released below */ }
    throw err;
  } finally {
    conn.release();
  }
}

export async function listFlagAudit(key, { limit = 50, pool = null } = {}) {
  const n = Math.max(1, Math.min(200, Number(limit) || 50));
  const [rows] = await (pool || getPool()).query(
    `SELECT a.id, a.action, a.old_value, a.new_value, a.detail, a.ip, a.created_at,
            a.changed_by_user_id, u.name AS changed_by_name
       FROM feature_flag_audit a
       LEFT JOIN users u ON u.id = a.changed_by_user_id
      WHERE a.flag_key = ?
      ORDER BY a.id DESC
      LIMIT ${n}`,
    [key]
  );
  return rows;
}

export const CLAIMS_FLAG = "claims_enabled";
export const __testables = { TTL_MS, flagCache, listCache };
