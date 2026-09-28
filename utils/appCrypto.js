// src/utils/appCrypto.js
//
// AES-256-GCM encryption for values stored in `app_settings` (WhatsApp access
// token, Meta app secret, webhook verify token).
//
// WHY GCM: it authenticates the ciphertext, so a tampered row fails to decrypt
// instead of silently yielding garbage that we would then send to Meta.
//
// The master key lives ONLY in the environment (SETTINGS_ENCRYPTION_KEY) and
// never in the database — otherwise encrypting at rest would be theatre.
//
// Stored format:  v1.<iv-base64>.<authTag-base64>.<ciphertext-base64>
// The version prefix means a future key rotation or algorithm change can be
// rolled out without guessing how an existing row was written.
//
import crypto from "crypto";

const ALGORITHM = "aes-256-gcm";
const VERSION = "v1";
const IV_BYTES = 12; // 96-bit nonce, the GCM recommendation
const KEY_BYTES = 32;

export class SettingsCryptoError extends Error {
  constructor(message, code = "settings_crypto_error") {
    super(message);
    this.name = "SettingsCryptoError";
    this.code = code;
  }
}

let cachedKey = null;

/**
 * Resolve the master key from SETTINGS_ENCRYPTION_KEY.
 * Accepts 64 hex characters or 32 raw bytes in base64. Anything else is
 * rejected loudly rather than silently padded — a weak key here would make the
 * whole exercise pointless.
 */
export function getMasterKey() {
  if (cachedKey) return cachedKey;

  const raw = (process.env.SETTINGS_ENCRYPTION_KEY || "").trim();
  if (!raw) {
    throw new SettingsCryptoError(
      "SETTINGS_ENCRYPTION_KEY is not set. Generate one with: openssl rand -hex 32",
      "missing_encryption_key"
    );
  }

  let key = null;
  if (/^[0-9a-fA-F]{64}$/.test(raw)) {
    key = Buffer.from(raw, "hex");
  } else {
    try {
      const candidate = Buffer.from(raw, "base64");
      if (candidate.length === KEY_BYTES) key = candidate;
    } catch {
      key = null;
    }
  }

  if (!key || key.length !== KEY_BYTES) {
    throw new SettingsCryptoError(
      "SETTINGS_ENCRYPTION_KEY must be 32 bytes: 64 hex characters (openssl rand -hex 32) or base64.",
      "invalid_encryption_key"
    );
  }

  cachedKey = key;
  return cachedKey;
}

/** True when the environment holds a usable master key. Never throws. */
export function encryptionAvailable() {
  try {
    getMasterKey();
    return true;
  } catch {
    return false;
  }
}

/** Test hook: forget the memoised key (e.g. after changing the env in a test). */
export function resetKeyCache() {
  cachedKey = null;
}

export function isEncrypted(value) {
  return typeof value === "string" && value.startsWith(`${VERSION}.`);
}

/** Encrypt a plaintext secret. Returns null for null/empty input. */
export function encryptSecret(plaintext) {
  if (plaintext === null || plaintext === undefined || plaintext === "") return null;
  const key = getMasterKey();
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(String(plaintext), "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  return [
    VERSION,
    iv.toString("base64"),
    authTag.toString("base64"),
    ciphertext.toString("base64"),
  ].join(".");
}

/**
 * Decrypt a stored secret.
 *
 * A value that is not in our envelope format is returned as-is: that covers the
 * first-boot case where an operator has pasted a token straight into the
 * database, and means a misconfigured key degrades to "the old value still
 * works" rather than "the integration dies".
 */
export function decryptSecret(stored) {
  if (stored === null || stored === undefined || stored === "") return null;
  if (!isEncrypted(stored)) return String(stored);

  const parts = String(stored).split(".");
  if (parts.length !== 4) {
    throw new SettingsCryptoError("Stored secret is malformed", "malformed_secret");
  }
  const [, ivB64, tagB64, dataB64] = parts;
  try {
    const key = getMasterKey();
    const decipher = crypto.createDecipheriv(
      ALGORITHM,
      key,
      Buffer.from(ivB64, "base64")
    );
    decipher.setAuthTag(Buffer.from(tagB64, "base64"));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(dataB64, "base64")),
      decipher.final(),
    ]);
    return plaintext.toString("utf8");
  } catch (err) {
    if (err instanceof SettingsCryptoError) throw err;
    throw new SettingsCryptoError(
      "Failed to decrypt a stored secret. The encryption key may have changed.",
      "decryption_failed"
    );
  }
}

/**
 * Display form for a secret: never the value itself.
 * "EAAG...xyz9" → "••••••••xyz9"
 */
export function maskSecret(plaintext, visibleTail = 4) {
  if (!plaintext) return null;
  const s = String(plaintext);
  if (s.length <= visibleTail) return "•".repeat(8);
  return "•".repeat(8) + s.slice(-visibleTail);
}

/** A webhook verify token the operator can paste into the Meta dashboard. */
export function generateVerifyToken() {
  return `aas_wh_${crypto.randomBytes(24).toString("base64url")}`;
}
