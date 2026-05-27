// src/models/apiKeyModel.js
//
// Storage layer for 3rd-party API keys. Secrets are never persisted — only a
// SHA-256 hash plus the short prefix that the integrator can use to identify
// their key in a list.
//
// The available scope catalogue is exported here so the controller, middleware,
// and admin UI all agree on the same set of strings. Adding a new scope is a
// single edit to ALLOWED_SCOPES.
import crypto from "crypto";
import getPool from "../utils/db.js";

/**
 * The full catalogue of permissions a key can be issued with. Keep this list
 * authoritative: every protected route should call `requireScope(...)` with
 * one of these values, and the public docs should mirror exactly this list.
 */
export const ALLOWED_SCOPES = [
  // Read-only catalogue (plans available to sell).
  "catalogue:read",

  // Read + write the buyer's own cases (insured persons + travel info).
  "cases:read",
  "cases:write",

  // Sales (confirmation, listing, invoice/certificate downloads).
  "sales:read",
  "sales:write",
  "sales:payment", // mark sales as paid / change payment status

  // Reports
  "ledger:read",
  "invoices:read",

  // Agent self-service (read own profile + manage own sub-agents).
  "agents:read",
  "agents:write"
];

const ALLOWED_SCOPE_SET = new Set(ALLOWED_SCOPES);

/** Format: aas_live_<48 random base64url chars>. ~48*6 ≈ 288 bits of entropy. */
const KEY_PREFIX = "aas_live_";
const SECRET_BYTES = 36; // 36 random bytes → 48 base64url chars after encoding

/** Generate a fresh secret. Returns the full plaintext token + its hash + display prefix. */
export function generateApiKeySecret() {
  const random = crypto.randomBytes(SECRET_BYTES).toString("base64url");
  const fullKey = `${KEY_PREFIX}${random}`;
  const keyHash = sha256(fullKey);
  const keyPrefix = fullKey.slice(0, KEY_PREFIX.length + 4); // e.g. "aas_live_4f9a"
  return { fullKey, keyHash, keyPrefix };
}

/** Hex SHA-256 of any string. Used both at write (storage) and read (lookup). */
export function sha256(value) {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

export function isAllowedScope(scope) {
  return ALLOWED_SCOPE_SET.has(scope);
}

/** Sanitise + validate an incoming scope list. Throws on unknown entries. */
export function sanitizeScopes(scopes) {
  if (!Array.isArray(scopes) || scopes.length === 0) {
    throw new Error("At least one scope is required");
  }
  const unique = Array.from(new Set(scopes.map((s) => String(s).trim()).filter(Boolean)));
  for (const s of unique) {
    if (!ALLOWED_SCOPE_SET.has(s)) {
      throw new Error(`Unknown scope: ${s}`);
    }
  }
  return unique;
}

/** Parse a comma/space-separated list of CIDR/IP strings into a clean array. */
export function parseIpAllowlist(raw) {
  if (!raw) return null;
  if (Array.isArray(raw)) {
    const cleaned = raw.map((s) => String(s).trim()).filter(Boolean);
    return cleaned.length ? cleaned.join(",") : null;
  }
  const cleaned = String(raw)
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  return cleaned.length ? cleaned.join(",") : null;
}

/** Insert a new API key row. Caller is expected to supply the secret hash + prefix. */
export const insertApiKey = async ({
  ownerUserId,
  name,
  keyPrefix,
  keyHash,
  scopes,
  ipAllowlist,
  rateLimitPerMin,
  expiresAt,
  createdByUserId
}) => {
  const pool = getPool();
  const [result] = await pool.execute(
    `INSERT INTO api_keys
      (owner_user_id, name, key_prefix, key_hash, scopes, ip_allowlist,
       rate_limit_per_min, status, expires_at, created_by_user_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
    [
      ownerUserId,
      name,
      keyPrefix,
      keyHash,
      JSON.stringify(scopes),
      ipAllowlist || null,
      rateLimitPerMin || null,
      expiresAt || null,
      createdByUserId
    ]
  );
  return result.insertId;
};

/**
 * Look up an active, non-expired key by the SHA-256 of the presented secret.
 * Returns the row joined with the owner's role/status, or null on miss.
 */
export const findActiveApiKeyByHash = async (keyHash) => {
  const pool = getPool();
  const [rows] = await pool.query(
    `SELECT k.id, k.owner_user_id, k.name, k.key_prefix, k.scopes,
            k.ip_allowlist, k.rate_limit_per_min, k.status, k.expires_at,
            u.role AS owner_role, u.status AS owner_status, u.email AS owner_email
       FROM api_keys k
       JOIN users u ON u.id = k.owner_user_id
      WHERE k.key_hash = ? LIMIT 1`,
    [keyHash]
  );
  return rows[0] || null;
};

/** Record this request against the key so the admin can see usage + abuse. */
export const recordApiKeyUsage = async ({
  apiKeyId,
  method,
  path,
  statusCode,
  ip,
  userAgent,
  elapsedMs
}) => {
  const pool = getPool();
  await pool.execute(
    `INSERT INTO api_key_usage
      (api_key_id, method, path, status_code, ip, user_agent, elapsed_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      apiKeyId,
      method,
      (path || "").slice(0, 255),
      statusCode,
      ip || null,
      userAgent ? userAgent.slice(0, 255) : null,
      elapsedMs ?? null
    ]
  );
};

/** Mostly cosmetic — updates the "last seen" timestamp shown in the admin UI. */
export const touchApiKey = async (apiKeyId, ip) => {
  const pool = getPool();
  await pool.execute(
    `UPDATE api_keys SET last_used_at = NOW(), last_used_ip = ? WHERE id = ?`,
    [ip || null, apiKeyId]
  );
};

/** List keys, optionally filtered to a single owner. Never leaks the hash. */
export const listApiKeys = async ({ ownerUserId } = {}) => {
  const pool = getPool();
  const params = [];
  let where = "";
  if (ownerUserId) {
    where = "WHERE k.owner_user_id = ?";
    params.push(ownerUserId);
  }
  const [rows] = await pool.query(
    `SELECT k.id, k.owner_user_id, k.name, k.key_prefix, k.scopes,
            k.ip_allowlist, k.rate_limit_per_min, k.status, k.expires_at,
            k.last_used_at, k.last_used_ip, k.created_by_user_id, k.created_at,
            k.revoked_at,
            owner.email AS owner_email, owner.name AS owner_name, owner.role AS owner_role,
            creator.email AS created_by_email
       FROM api_keys k
       JOIN users owner ON owner.id = k.owner_user_id
       JOIN users creator ON creator.id = k.created_by_user_id
       ${where}
       ORDER BY k.created_at DESC`,
    params
  );
  return rows;
};

export const getApiKeyById = async (id) => {
  const pool = getPool();
  const [rows] = await pool.query(
    `SELECT k.*, owner.email AS owner_email, owner.role AS owner_role
       FROM api_keys k
       JOIN users owner ON owner.id = k.owner_user_id
      WHERE k.id = ? LIMIT 1`,
    [id]
  );
  return rows[0] || null;
};

export const revokeApiKey = async (id) => {
  const pool = getPool();
  await pool.execute(
    `UPDATE api_keys SET status = 'revoked', revoked_at = NOW() WHERE id = ?`,
    [id]
  );
};

export const updateApiKeyMetadata = async (id, { name, ipAllowlist, rateLimitPerMin, expiresAt, scopes }) => {
  const pool = getPool();
  const fields = [];
  const params = [];
  if (name !== undefined) {
    fields.push("name = ?");
    params.push(name);
  }
  if (ipAllowlist !== undefined) {
    fields.push("ip_allowlist = ?");
    params.push(ipAllowlist);
  }
  if (rateLimitPerMin !== undefined) {
    fields.push("rate_limit_per_min = ?");
    params.push(rateLimitPerMin);
  }
  if (expiresAt !== undefined) {
    fields.push("expires_at = ?");
    params.push(expiresAt);
  }
  if (scopes !== undefined) {
    fields.push("scopes = ?");
    params.push(JSON.stringify(scopes));
  }
  if (fields.length === 0) return;
  params.push(id);
  await pool.execute(`UPDATE api_keys SET ${fields.join(", ")} WHERE id = ?`, params);
};

/** Recent usage of a single key for the admin UI graphs. */
export const getApiKeyRecentUsage = async (apiKeyId, limit = 100) => {
  const pool = getPool();
  const limitNum = Math.min(500, Math.max(1, Number(limit) || 100));
  const [rows] = await pool.query(
    `SELECT id, method, path, status_code, ip, elapsed_ms, created_at
       FROM api_key_usage
      WHERE api_key_id = ?
      ORDER BY id DESC
      LIMIT ?`,
    [apiKeyId, limitNum]
  );
  return rows;
};
