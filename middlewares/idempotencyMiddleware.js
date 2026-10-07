// src/middlewares/idempotencyMiddleware.js
//
// Make an unsafe POST safe to retry.
//
// The money path had no protection at all: a partner whose request timed out
// and retried it issued a second policy, with its own certificate and invoice.
// The sale endpoints now also dedupe on the case, but that only covers one
// shape of duplicate — this covers the general one, and is what a payment
// provider's retried callback will rely on.
//
// Mechanics: the UNIQUE (scope, idempotency_key) index is the referee. Two
// concurrent requests with the same key race to INSERT; exactly one wins and
// executes, the loser is told to retry and finds the recorded response.
//
// The header is OPTIONAL. Sending none keeps the old behaviour, so no existing
// caller breaks; the documentation asks integrators to send one.
//
import crypto from "crypto";
import getPool from "../utils/db.js";

const HEADER = "idempotency-key";
const MAX_KEY_LENGTH = 255;

/** Stable hash of the request body, so one key cannot be reused for another. */
function fingerprint(body) {
  const canonical = JSON.stringify(sortDeep(body ?? null));
  return crypto.createHash("sha256").update(canonical, "utf8").digest("hex");
}

/** Key order must not change the hash, or a reordered client payload looks new. */
function sortDeep(value) {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value && typeof value === "object") {
    return Object.keys(value)
      .sort()
      .reduce((acc, k) => {
        acc[k] = sortDeep(value[k]);
        return acc;
      }, {});
  }
  return value;
}

/**
 * @param {string} scope Route identity, e.g. "sales:create". Two different
 *   routes may legitimately see the same key from the same client, so the
 *   uniqueness is per route rather than global.
 */
export function idempotency(scope) {
  return async function idempotencyMiddleware(req, res, next) {
    const key = String(req.get(HEADER) || "").trim();
    if (!key) return next();

    if (key.length > MAX_KEY_LENGTH) {
      return res.status(400).json({
        success: false,
        error: { code: "idempotency_key_too_long", message: `Idempotency-Key must be ${MAX_KEY_LENGTH} characters or fewer` },
      });
    }

    const pool = getPool();
    const fp = fingerprint(req.body);

    try {
      await pool.execute(
        `INSERT INTO idempotency_keys
           (idempotency_key, scope, request_fingerprint, status, actor_user_id, api_key_id)
         VALUES (?, ?, ?, 'in_progress', ?, ?)`,
        [key, scope, fp, req.user?.id ?? null, req.apiKey?.id ?? null]
      );
    } catch (err) {
      if (err?.code !== "ER_DUP_ENTRY") throw err;
      return replayOrReject(pool, { scope, key, fp, res });
    }

    // We own this key. Capture whatever the handler answers so a retry can be
    // served the same thing, then let the handler run.
    const originalJson = res.json.bind(res);
    let recorded = false;
    res.json = (body) => {
      if (!recorded) {
        recorded = true;
        const status = res.statusCode || 200;
        // Fire and forget: a failure to record must not fail the request the
        // customer is waiting on. The row stays 'in_progress' and expires with
        // the retention sweep.
        pool
          .execute(
            `UPDATE idempotency_keys
                SET status = ?, response_status = ?, response_body = ?, completed_at = NOW()
              WHERE scope = ? AND idempotency_key = ?`,
            [status < 400 ? "completed" : "failed", status, JSON.stringify(body ?? null), scope, key]
          )
          .catch((e) => console.error("idempotency: could not record response:", e.message));
      }
      return originalJson(body);
    };

    next();
  };
}

async function replayOrReject(pool, { scope, key, fp, res }) {
  const [rows] = await pool.query(
    `SELECT request_fingerprint, status, response_status, response_body
       FROM idempotency_keys WHERE scope = ? AND idempotency_key = ? LIMIT 1`,
    [scope, key]
  );
  const row = rows[0];
  if (!row) {
    // Vanishingly rare: the row was pruned between the INSERT failing and this
    // read. Treat it as a fresh request rather than inventing an error.
    return res.status(409).json({
      success: false,
      error: { code: "idempotency_retry", message: "Retry this request" },
    });
  }

  if (row.request_fingerprint !== fp) {
    return res.status(422).json({
      success: false,
      error: {
        code: "idempotency_key_reuse",
        message: "This Idempotency-Key was already used with a different request body",
      },
    });
  }

  if (row.status === "in_progress") {
    res.set("Retry-After", "2");
    return res.status(409).json({
      success: false,
      error: {
        code: "idempotency_in_progress",
        message: "An identical request is still being processed. Retry shortly.",
      },
    });
  }

  const body = typeof row.response_body === "string" ? JSON.parse(row.response_body) : row.response_body;
  res.set("Idempotent-Replay", "true");
  return res.status(row.response_status || 200).json(body);
}

export const __testables = { fingerprint, sortDeep };
