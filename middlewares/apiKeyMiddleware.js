// src/middlewares/apiKeyMiddleware.js
//
// Unified authentication for the public API. The same `Authorization: Bearer ...`
// header can carry either a JWT (issued by the existing /api/auth/login flow,
// used by our own frontend) or an opaque API key in the form `aas_live_xxx`
// issued via the admin /api/admin/api-keys endpoints.
//
//   - JWT → populates `req.user = { id, email, role }` (legacy behaviour).
//   - API key → populates the same `req.user` (so downstream controllers don't
//     need to special-case auth mode) AND `req.apiKey` with the key metadata.
//
// API keys also get:
//   * Scope checks via `requireScope("cases:read")`.
//   * IP allowlist enforcement.
//   * Per-key rate limiting (in addition to the global IP limit).
//   * Audit logging of every request.
//
// Both modes converge so existing route handlers keep working. The only new
// concept on protected routes is `requireScope(...)`.
//
import jwt from "jsonwebtoken";
import {
  findActiveApiKeyByHash,
  sha256,
  touchApiKey,
  recordApiKeyUsage
} from "../models/apiKeyModel.js";

const API_KEY_PREFIX = "aas_live_";

/** Default per-key requests per minute when the key row has no override. */
const DEFAULT_KEY_RPM = Number(process.env.API_KEY_DEFAULT_RPM) || 120;

/**
 * In-process sliding-window counter, keyed by api_key_id. Sufficient for a
 * single-instance deployment. For a clustered deployment swap this for Redis
 * (see `INCR` + `PEXPIRE` recipe in docs/SECURITY.md).
 */
const rateBuckets = new Map();
function rateCheck(apiKeyId, limitPerMin) {
  const now = Date.now();
  const windowMs = 60_000;
  const limit = limitPerMin || DEFAULT_KEY_RPM;
  const bucket = rateBuckets.get(apiKeyId) || { resetAt: now + windowMs, count: 0 };
  if (now >= bucket.resetAt) {
    bucket.resetAt = now + windowMs;
    bucket.count = 0;
  }
  bucket.count += 1;
  rateBuckets.set(apiKeyId, bucket);
  return {
    allowed: bucket.count <= limit,
    remaining: Math.max(0, limit - bucket.count),
    resetSeconds: Math.ceil((bucket.resetAt - now) / 1000),
    limit
  };
}

/** Extract the client IP, preferring the leftmost X-Forwarded-For entry. */
function clientIp(req) {
  const xff = req.headers["x-forwarded-for"];
  if (typeof xff === "string" && xff.length > 0) {
    return xff.split(",")[0].trim();
  }
  return req.ip || req.socket?.remoteAddress || null;
}

/** Compare an IP against a comma-separated list of plain IPs / CIDRs. */
function ipMatchesAllowlist(ip, allowlistCsv) {
  if (!allowlistCsv) return true;
  if (!ip) return false;
  const entries = allowlistCsv
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
  if (entries.length === 0) return true;
  for (const entry of entries) {
    if (entry.includes("/")) {
      if (ipInCidr(ip, entry)) return true;
    } else if (entry === ip) {
      return true;
    }
  }
  return false;
}

/** Minimal IPv4-only CIDR check; IPv6 entries match literally only. */
function ipInCidr(ip, cidr) {
  const [range, bitsRaw] = cidr.split("/");
  const bits = parseInt(bitsRaw, 10);
  if (!Number.isFinite(bits) || bits < 0 || bits > 32) return false;
  const toInt = (s) => {
    const parts = s.split(".").map(Number);
    if (parts.length !== 4 || parts.some((p) => !Number.isFinite(p) || p < 0 || p > 255)) {
      return null;
    }
    return (parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3];
  };
  const ipInt = toInt(ip);
  const rangeInt = toInt(range);
  if (ipInt === null || rangeInt === null) return false;
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (ipInt & mask) === (rangeInt & mask);
}

/**
 * Wrap `res.end` so we can log the final status code + elapsed time once the
 * response is on the wire. Fire-and-forget; failures here must never break the
 * response itself.
 */
function attachUsageLogger(req, res, apiKey, startedAt) {
  const originalEnd = res.end.bind(res);
  let logged = false;
  res.end = function patchedEnd(chunk, encoding, cb) {
    if (!logged) {
      logged = true;
      const elapsedMs = Date.now() - startedAt;
      const ip = clientIp(req);
      recordApiKeyUsage({
        apiKeyId: apiKey.id,
        method: req.method,
        path: req.originalUrl || req.url,
        statusCode: res.statusCode,
        ip,
        userAgent: req.headers["user-agent"] || null,
        elapsedMs
      }).catch((e) => console.warn("api_key_usage log failed:", e.message));
      touchApiKey(apiKey.id, ip).catch(() => {});
    }
    return originalEnd(chunk, encoding, cb);
  };
}

/**
 * Drop-in replacement for the JWT-only `authenticate` middleware.
 *
 * Accepts either:
 *   1. A JWT (signed by JWT_SECRET) — preserves the existing internal flow.
 *   2. An API key starting with `aas_live_` — looked up by SHA-256 of the
 *      presented token.
 *
 * Sets `req.user` either way. API keys also set `req.apiKey`.
 */
export const authenticateAny = async (req, res, next) => {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) {
    return res.status(401).json({
      success: false,
      error: { code: "missing_token", message: "Missing Authorization: Bearer header" }
    });
  }
  const token = header.slice("Bearer ".length).trim();

  // API key mode
  if (token.startsWith(API_KEY_PREFIX)) {
    try {
      const keyHash = sha256(token);
      const row = await findActiveApiKeyByHash(keyHash);
      if (!row) {
        return res.status(401).json({
          success: false,
          error: { code: "invalid_api_key", message: "API key not recognised" }
        });
      }
      if (row.status !== "active") {
        return res.status(401).json({
          success: false,
          error: { code: "revoked_api_key", message: "API key has been revoked" }
        });
      }
      if (row.expires_at && new Date(row.expires_at).getTime() < Date.now()) {
        return res.status(401).json({
          success: false,
          error: { code: "expired_api_key", message: "API key has expired" }
        });
      }
      if (row.owner_status !== "active") {
        return res.status(401).json({
          success: false,
          error: { code: "owner_disabled", message: "The user owning this key is disabled" }
        });
      }
      const ip = clientIp(req);
      if (!ipMatchesAllowlist(ip, row.ip_allowlist)) {
        return res.status(403).json({
          success: false,
          error: { code: "ip_not_allowed", message: "Request IP is not on the key's allowlist" }
        });
      }
      const limit = rateCheck(row.id, row.rate_limit_per_min);
      res.setHeader("X-RateLimit-Limit", String(limit.limit));
      res.setHeader("X-RateLimit-Remaining", String(limit.remaining));
      res.setHeader("X-RateLimit-Reset", String(limit.resetSeconds));
      if (!limit.allowed) {
        return res.status(429).json({
          success: false,
          error: {
            code: "rate_limited",
            message: `Rate limit exceeded (${limit.limit}/min). Retry in ${limit.resetSeconds}s.`
          }
        });
      }

      const scopes = parseScopes(row.scopes);
      req.user = {
        id: row.owner_user_id,
        email: row.owner_email,
        role: row.owner_role
      };
      req.apiKey = {
        id: row.id,
        name: row.name,
        prefix: row.key_prefix,
        scopes,
        owner_user_id: row.owner_user_id
      };
      req.authMode = "api_key";

      attachUsageLogger(req, res, row, Date.now());
      return next();
    } catch (err) {
      console.error("API key auth error:", err);
      return res.status(500).json({
        success: false,
        error: { code: "auth_error", message: "Authentication error" }
      });
    }
  }

  // JWT mode (existing behaviour)
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    req.user = payload;
    req.authMode = "jwt";
    return next();
  } catch (err) {
    return res.status(401).json({
      success: false,
      error: { code: "invalid_token", message: "Invalid or expired token" }
    });
  }
};

/**
 * Strict API-key-only authentication. Use on endpoints we DON'T want internal
 * cookies/JWTs to hit (e.g. the public read-only invoice fetch route).
 */
export const authenticateApiKeyOnly = async (req, res, next) => {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ") || !header.includes(API_KEY_PREFIX)) {
    return res.status(401).json({
      success: false,
      error: { code: "api_key_required", message: "API key required" }
    });
  }
  return authenticateAny(req, res, next);
};

/**
 * Scope guard for API-key requests. If the request was authenticated with a
 * JWT, scopes are implicit (admin/sub_admin/agent already enforced elsewhere),
 * so the check is a no-op.
 */
export const requireScope = (scope) => (req, res, next) => {
  if (req.authMode !== "api_key") return next();
  const scopes = req.apiKey?.scopes || [];
  if (!scopes.includes(scope)) {
    return res.status(403).json({
      success: false,
      error: {
        code: "insufficient_scope",
        message: `Missing required scope: ${scope}`,
        requiredScope: scope,
        availableScopes: scopes
      }
    });
  }
  return next();
};

function parseScopes(raw) {
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === "object") return raw.scopes || [];
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw);
    } catch {
      return [];
    }
  }
  return [];
}
