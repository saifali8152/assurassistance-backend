// src/utils/whatsapp/signature.js
//
// Verification of Meta's X-Hub-Signature-256 header.
//
// WHY THIS MATTERS: the webhook is a public HTTPS endpoint that creates
// conversations and eventually quotes. Without signature verification anyone who
// learns the URL can inject messages that appear to come from a customer.
//
// THE SUBTLETY: the signature is computed over the EXACT raw request bytes. Once
// express.json() has parsed and re-serialised the body, the bytes are gone — key
// order and whitespace will differ and every signature will fail. That is why the
// webhook route is mounted with express.raw() BEFORE express.json() in server.js.
//
import crypto from "crypto";

export const SIGNATURE_HEADER = "x-hub-signature-256";

/**
 * @param {Buffer|string} rawBody exactly what arrived on the wire
 * @param {string} signatureHeader value of X-Hub-Signature-256 ("sha256=…")
 * @param {string} appSecret Meta app secret
 * @returns {{valid: boolean, reason?: string}}
 */
export function verifySignature(rawBody, signatureHeader, appSecret) {
  if (!appSecret) return { valid: false, reason: "app_secret_not_configured" };
  if (!signatureHeader) return { valid: false, reason: "signature_header_missing" };
  if (rawBody === null || rawBody === undefined) return { valid: false, reason: "empty_body" };

  const header = String(signatureHeader).trim();
  if (!header.startsWith("sha256=")) return { valid: false, reason: "unsupported_signature_algorithm" };

  const provided = header.slice("sha256=".length).trim();
  if (!/^[0-9a-fA-F]{64}$/.test(provided)) return { valid: false, reason: "malformed_signature" };

  const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody), "utf8");
  const expected = crypto.createHmac("sha256", appSecret).update(body).digest("hex");

  // Constant-time compare: a fast-exit comparison leaks how much of a forged
  // signature was correct, which is enough to reconstruct it byte by byte.
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(provided.toLowerCase(), "utf8");
  if (a.length !== b.length) return { valid: false, reason: "signature_mismatch" };
  if (!crypto.timingSafeEqual(a, b)) return { valid: false, reason: "signature_mismatch" };

  return { valid: true };
}

/** Test helper: produce the header Meta would send for a given body. */
export function signBody(rawBody, appSecret) {
  const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody), "utf8");
  return `sha256=${crypto.createHmac("sha256", appSecret).update(body).digest("hex")}`;
}

/**
 * Compare the verify token Meta echoes during webhook setup.
 * Constant-time, for the same reason as above.
 */
export function verifyTokenMatches(provided, expected) {
  if (!provided || !expected) return false;
  const a = Buffer.from(String(provided), "utf8");
  const b = Buffer.from(String(expected), "utf8");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}
