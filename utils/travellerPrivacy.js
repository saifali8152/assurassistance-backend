// src/utils/travellerPrivacy.js
//
// Passport numbers, encrypted at rest.
//
// The platform already had AES-256-GCM for operator credentials; this points it
// at the one piece of customer data that genuinely needs it. Everything funnels
// through here so there is one place that knows the rules.
//
// DEGRADES, NEVER BREAKS. With no SETTINGS_ENCRYPTION_KEY the platform keeps
// working on plaintext exactly as before — refusing to issue policies because a
// key is missing would be a worse outcome than the problem. `encryptionReady()`
// says which mode you are in.
//
// THE BLIND INDEX. Ciphertext differs on every write (a fresh IV, which is the
// point), so an encrypted column cannot be searched. The HMAC makes exact
// lookup work. Partial search over passport numbers does not survive, and
// should not: a system that lets you type three digits and list every matching
// passport is the thing encryption is meant to prevent.
//
import crypto from "crypto";
import { encryptSecret, decryptSecret, encryptionAvailable } from "./appCrypto.js";

export function encryptionReady() {
  return encryptionAvailable();
}

/** Upper-cased, stripped of spaces and punctuation — so "ab 123" and "AB123" match. */
export function normalisePassport(value) {
  return String(value ?? "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

/**
 * Deterministic index for exact lookup.
 *
 * Keyed with the same master secret, so the index is useless to anyone who gets
 * the database without the key — an unkeyed hash of a passport number is
 * trivially reversible by brute force, the space is far too small.
 */
export function passportHash(value) {
  const normalised = normalisePassport(value);
  if (!normalised) return null;
  const key = process.env.SETTINGS_ENCRYPTION_KEY || "";
  if (!key) return null;
  return crypto.createHmac("sha256", key).update(`passport:${normalised}`).digest("hex");
}

/**
 * The columns to write for a passport number.
 *
 * With a key: ciphertext and index set, plaintext column NULL — so nothing new
 * is ever written in the clear. Without one: plaintext as before, because the
 * alternative is losing the number.
 */
export function passportColumns(value) {
  const raw = value == null || value === "" ? null : String(value);
  if (!raw) return { passport_or_id: null, passport_or_id_enc: null, passport_or_id_hash: null };
  if (!encryptionReady()) {
    return { passport_or_id: raw, passport_or_id_enc: null, passport_or_id_hash: null };
  }
  return {
    passport_or_id: null,
    passport_or_id_enc: encryptSecret(raw),
    passport_or_id_hash: passportHash(raw),
  };
}

/**
 * Read a passport number from a row, whichever way it was stored.
 *
 * Returns null rather than throwing when the ciphertext cannot be read — a
 * certificate missing an ID number is recoverable; a 500 on every document for
 * that customer is not. The caller sees null and the operator sees the decrypt
 * error in the settings screen.
 */
export function readPassport(row) {
  if (!row) return null;
  if (row.passport_or_id_enc) {
    try {
      return decryptSecret(row.passport_or_id_enc);
    } catch {
      return null;
    }
  }
  return row.passport_or_id ?? null;
}

/** Put the readable value back on a row, for code that expects the old shape. */
export function hydrateTraveller(row) {
  if (!row) return row;
  if (!row.passport_or_id_enc) return row;
  return { ...row, passport_or_id: readPassport(row) };
}

export function hydrateTravellers(rows) {
  return Array.isArray(rows) ? rows.map(hydrateTraveller) : rows;
}
