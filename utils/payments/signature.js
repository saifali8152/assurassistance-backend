// src/utils/payments/signature.js
//
// Callback signature verification, shared by every provider.
//
// Each provider signs differently — a different header name, a different digest
// encoding, sometimes a prefix — but the dangerous parts are identical, so they
// are solved once here: verify over the RAW bytes, compare in constant time,
// and fail closed when no secret is configured.
//
// RAW BYTES: once express.json() has parsed and re-serialised a body, key order
// and whitespace differ and every signature fails. The payment callback route is
// mounted with express.raw() before express.json() for exactly this reason, the
// same way the Meta webhook is.
//
import crypto from "crypto";

/** Encodings providers use for the digest. */
export const ENCODINGS = ["hex", "base64"];

/**
 * @param {object} opts
 * @param {Buffer|string} opts.rawBody exactly what arrived on the wire
 * @param {string} opts.signature the header value as received
 * @param {string} opts.secret shared secret from settings
 * @param {string} [opts.algorithm="sha256"]
 * @param {string} [opts.encoding="hex"]
 * @param {string} [opts.prefix] e.g. "sha256=" — stripped before comparing
 * @returns {{valid: boolean, reason?: string}}
 */
export function verifyHmac({ rawBody, signature, secret, algorithm = "sha256", encoding = "hex", prefix = "" }) {
  // Fail closed. An unconfigured secret must never mean "accept anything",
  // which is the shape of mistake that turns a callback into a free policy.
  if (!secret) return { valid: false, reason: "secret_not_configured" };
  if (!signature) return { valid: false, reason: "signature_header_missing" };
  if (rawBody === null || rawBody === undefined) return { valid: false, reason: "empty_body" };
  if (!ENCODINGS.includes(encoding)) return { valid: false, reason: "unsupported_encoding" };

  let provided = String(signature).trim();
  if (prefix) {
    if (!provided.startsWith(prefix)) return { valid: false, reason: "unexpected_signature_prefix" };
    provided = provided.slice(prefix.length).trim();
  }
  if (!provided) return { valid: false, reason: "malformed_signature" };

  const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody), "utf8");

  let expected;
  try {
    expected = crypto.createHmac(algorithm, secret).update(body).digest(encoding);
  } catch {
    return { valid: false, reason: "unsupported_algorithm" };
  }

  // Compare the decoded digests, not the strings: hex case and base64 padding
  // differ between providers and a string compare would reject a valid header.
  const a = decodeDigest(expected, encoding);
  const b = decodeDigest(provided, encoding);
  if (!a || !b || a.length !== b.length) return { valid: false, reason: "signature_mismatch" };
  if (!crypto.timingSafeEqual(a, b)) return { valid: false, reason: "signature_mismatch" };

  return { valid: true };
}

function decodeDigest(value, encoding) {
  try {
    const buf = Buffer.from(value, encoding);
    // Buffer.from is permissive: it silently drops invalid characters rather
    // than throwing, so a garbage header would decode to a short buffer and
    // read as a length mismatch. Re-encoding catches that explicitly.
    if (buf.length === 0) return null;
    return buf;
  } catch {
    return null;
  }
}

/** Test helper: produce the header a provider would send for a body. */
export function signBody({ rawBody, secret, algorithm = "sha256", encoding = "hex", prefix = "" }) {
  const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody), "utf8");
  return prefix + crypto.createHmac(algorithm, secret).update(body).digest(encoding);
}
