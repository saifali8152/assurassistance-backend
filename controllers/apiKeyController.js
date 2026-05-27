// src/controllers/apiKeyController.js
//
// Admin-only management of 3rd-party API keys.
//
//   POST   /api/admin/api-keys            create
//   GET    /api/admin/api-keys            list (with optional ?owner_user_id)
//   GET    /api/admin/api-keys/:id        details + recent usage
//   PATCH  /api/admin/api-keys/:id        update name/scopes/IP/rate
//   POST   /api/admin/api-keys/:id/rotate rotate the secret (revokes the old one)
//   DELETE /api/admin/api-keys/:id        revoke
//
// IMPORTANT: the full secret is ONLY returned in the create + rotate responses
// (the one and only time the admin can capture it). Subsequent reads never
// expose the secret again — only the key_prefix and metadata.
//
import {
  ALLOWED_SCOPES,
  generateApiKeySecret,
  sanitizeScopes,
  parseIpAllowlist,
  insertApiKey,
  listApiKeys,
  getApiKeyById,
  revokeApiKey,
  updateApiKeyMetadata,
  getApiKeyRecentUsage
} from "../models/apiKeyModel.js";
import { findUserById } from "../models/userModel.js";

/** Return the public catalogue of scope strings so the admin UI can render it. */
export const listScopes = async (_req, res) => {
  res.json({ success: true, data: ALLOWED_SCOPES });
};

export const createApiKey = async (req, res) => {
  try {
    const {
      name,
      owner_user_id: ownerUserId,
      scopes,
      ip_allowlist: ipAllowlistRaw,
      rate_limit_per_min: rateLimitRaw,
      expires_at: expiresAtRaw
    } = req.body || {};

    if (!name || String(name).trim().length === 0) {
      return res.status(400).json({
        success: false,
        error: { code: "validation_error", message: "name is required" }
      });
    }
    if (!ownerUserId || !Number.isFinite(Number(ownerUserId))) {
      return res.status(400).json({
        success: false,
        error: { code: "validation_error", message: "owner_user_id is required" }
      });
    }

    const owner = await findUserById(Number(ownerUserId));
    if (!owner) {
      return res.status(404).json({
        success: false,
        error: { code: "not_found", message: "Owner user not found" }
      });
    }
    if (owner.status !== "active") {
      return res.status(400).json({
        success: false,
        error: { code: "validation_error", message: "Owner user is not active" }
      });
    }

    let cleanScopes;
    try {
      cleanScopes = sanitizeScopes(scopes);
    } catch (e) {
      return res.status(400).json({
        success: false,
        error: { code: "validation_error", message: e.message }
      });
    }

    const ipAllowlist = parseIpAllowlist(ipAllowlistRaw);
    const rateLimit = rateLimitRaw ? Math.max(1, Math.min(10000, Number(rateLimitRaw))) : null;
    const expiresAt = expiresAtRaw ? new Date(expiresAtRaw) : null;
    if (expiresAt && Number.isNaN(expiresAt.getTime())) {
      return res.status(400).json({
        success: false,
        error: { code: "validation_error", message: "expires_at must be a valid ISO date" }
      });
    }

    const { fullKey, keyHash, keyPrefix } = generateApiKeySecret();
    const id = await insertApiKey({
      ownerUserId: Number(ownerUserId),
      name: String(name).trim(),
      keyPrefix,
      keyHash,
      scopes: cleanScopes,
      ipAllowlist,
      rateLimitPerMin: rateLimit,
      expiresAt,
      createdByUserId: req.user.id
    });

    res.status(201).json({
      success: true,
      data: {
        id,
        name: String(name).trim(),
        owner_user_id: Number(ownerUserId),
        scopes: cleanScopes,
        key_prefix: keyPrefix,
        // The full secret is shown ONLY here — store it securely.
        secret: fullKey,
        ip_allowlist: ipAllowlist,
        rate_limit_per_min: rateLimit,
        expires_at: expiresAt ? expiresAt.toISOString() : null
      },
      message:
        "API key created. Copy the secret now — it will not be shown again."
    });
  } catch (err) {
    console.error("createApiKey:", err);
    res.status(500).json({
      success: false,
      error: { code: "server_error", message: "Failed to create API key" }
    });
  }
};

export const listApiKeysController = async (req, res) => {
  try {
    const ownerUserId = req.query.owner_user_id
      ? Number(req.query.owner_user_id)
      : null;
    const rows = await listApiKeys({ ownerUserId });
    res.json({
      success: true,
      data: rows.map(serializeApiKey)
    });
  } catch (err) {
    console.error("listApiKeys:", err);
    res.status(500).json({
      success: false,
      error: { code: "server_error", message: "Failed to list API keys" }
    });
  }
};

export const getApiKeyController = async (req, res) => {
  try {
    const id = Number(req.params.id);
    const row = await getApiKeyById(id);
    if (!row) {
      return res.status(404).json({
        success: false,
        error: { code: "not_found", message: "API key not found" }
      });
    }
    const usage = await getApiKeyRecentUsage(id, 100);
    res.json({
      success: true,
      data: {
        ...serializeApiKey(row),
        recent_usage: usage
      }
    });
  } catch (err) {
    console.error("getApiKey:", err);
    res.status(500).json({
      success: false,
      error: { code: "server_error", message: "Failed to load API key" }
    });
  }
};

export const updateApiKeyController = async (req, res) => {
  try {
    const id = Number(req.params.id);
    const existing = await getApiKeyById(id);
    if (!existing) {
      return res.status(404).json({
        success: false,
        error: { code: "not_found", message: "API key not found" }
      });
    }

    const payload = {};
    if (typeof req.body?.name === "string") payload.name = req.body.name.trim();
    if (req.body?.ip_allowlist !== undefined) {
      payload.ipAllowlist = parseIpAllowlist(req.body.ip_allowlist);
    }
    if (req.body?.rate_limit_per_min !== undefined) {
      const n = Number(req.body.rate_limit_per_min);
      payload.rateLimitPerMin = Number.isFinite(n) && n > 0 ? Math.min(10000, n) : null;
    }
    if (req.body?.expires_at !== undefined) {
      if (req.body.expires_at === null || req.body.expires_at === "") {
        payload.expiresAt = null;
      } else {
        const d = new Date(req.body.expires_at);
        if (Number.isNaN(d.getTime())) {
          return res.status(400).json({
            success: false,
            error: { code: "validation_error", message: "expires_at must be a valid ISO date" }
          });
        }
        payload.expiresAt = d;
      }
    }
    if (req.body?.scopes !== undefined) {
      try {
        payload.scopes = sanitizeScopes(req.body.scopes);
      } catch (e) {
        return res.status(400).json({
          success: false,
          error: { code: "validation_error", message: e.message }
        });
      }
    }

    await updateApiKeyMetadata(id, payload);
    const updated = await getApiKeyById(id);
    res.json({ success: true, data: serializeApiKey(updated) });
  } catch (err) {
    console.error("updateApiKey:", err);
    res.status(500).json({
      success: false,
      error: { code: "server_error", message: "Failed to update API key" }
    });
  }
};

export const revokeApiKeyController = async (req, res) => {
  try {
    const id = Number(req.params.id);
    const existing = await getApiKeyById(id);
    if (!existing) {
      return res.status(404).json({
        success: false,
        error: { code: "not_found", message: "API key not found" }
      });
    }
    await revokeApiKey(id);
    res.json({ success: true, message: "API key revoked" });
  } catch (err) {
    console.error("revokeApiKey:", err);
    res.status(500).json({
      success: false,
      error: { code: "server_error", message: "Failed to revoke API key" }
    });
  }
};

/**
 * Rotate the secret: revoke the existing row and issue a fresh key with the
 * same name + scopes + IP allowlist + rate limit. Returns the new secret once.
 */
export const rotateApiKeyController = async (req, res) => {
  try {
    const id = Number(req.params.id);
    const existing = await getApiKeyById(id);
    if (!existing) {
      return res.status(404).json({
        success: false,
        error: { code: "not_found", message: "API key not found" }
      });
    }
    await revokeApiKey(id);
    const { fullKey, keyHash, keyPrefix } = generateApiKeySecret();
    const scopes = parseStoredScopes(existing.scopes);
    const newId = await insertApiKey({
      ownerUserId: existing.owner_user_id,
      name: existing.name,
      keyPrefix,
      keyHash,
      scopes,
      ipAllowlist: existing.ip_allowlist,
      rateLimitPerMin: existing.rate_limit_per_min,
      expiresAt: existing.expires_at,
      createdByUserId: req.user.id
    });
    res.json({
      success: true,
      data: {
        id: newId,
        name: existing.name,
        owner_user_id: existing.owner_user_id,
        scopes,
        key_prefix: keyPrefix,
        secret: fullKey,
        ip_allowlist: existing.ip_allowlist,
        rate_limit_per_min: existing.rate_limit_per_min,
        expires_at: existing.expires_at
      },
      message: "API key rotated. The previous secret is now revoked."
    });
  } catch (err) {
    console.error("rotateApiKey:", err);
    res.status(500).json({
      success: false,
      error: { code: "server_error", message: "Failed to rotate API key" }
    });
  }
};

function parseStoredScopes(raw) {
  if (Array.isArray(raw)) return raw;
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw);
    } catch {
      return [];
    }
  }
  return [];
}

/** Strip internal columns + parse JSON scopes for safe transport. */
function serializeApiKey(row) {
  return {
    id: row.id,
    name: row.name,
    key_prefix: row.key_prefix,
    scopes: parseStoredScopes(row.scopes),
    ip_allowlist: row.ip_allowlist,
    rate_limit_per_min: row.rate_limit_per_min,
    status: row.status,
    expires_at: row.expires_at,
    last_used_at: row.last_used_at,
    last_used_ip: row.last_used_ip,
    owner: {
      id: row.owner_user_id,
      email: row.owner_email,
      name: row.owner_name,
      role: row.owner_role
    },
    created_by: {
      id: row.created_by_user_id,
      email: row.created_by_email
    },
    created_at: row.created_at,
    revoked_at: row.revoked_at
  };
}
