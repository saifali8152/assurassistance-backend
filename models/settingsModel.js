// src/models/settingsModel.js
//
// Read/write access to `app_settings`, the superadmin-managed configuration
// store that replaces .env for operator-changeable values.
//
// The SETTING REGISTRY below is authoritative: a key that is not registered here
// cannot be written through the API, so a typo in a request body can never
// create a silent orphan row that nothing reads. The registry mirrors the seed
// in migrations/m2_02_app_settings.sql.
//
import getPool from "../utils/db.js";
import { encryptSecret, decryptSecret } from "../utils/appCrypto.js";

/**
 * group     — which UI section the field belongs to.
 * type      — how the value is coerced on read.
 * secret    — encrypted at rest, masked on read, write-only from the UI.
 * envFallback — read from process.env when the row is empty, so an existing
 *               deployment keeps working before the operator saves anything.
 */
export const SETTING_REGISTRY = {
  "whatsapp.enabled": {
    group: "status", type: "boolean", secret: false, default: false,
    description: "Master switch for the WhatsApp purchase flow",
  },
  "whatsapp.phone_number_id": {
    group: "connection", type: "string", secret: false,
    envFallback: "WHATSAPP_PHONE_NUMBER_ID",
    description: "Meta WhatsApp phone number ID",
  },
  "whatsapp.waba_id": {
    group: "connection", type: "string", secret: false,
    envFallback: "WHATSAPP_WABA_ID",
    description: "WhatsApp Business Account ID",
  },
  "whatsapp.business_number": {
    group: "connection", type: "string", secret: false,
    description: "Display number shown to customers and on certificates",
  },
  "whatsapp.api_version": {
    group: "connection", type: "string", secret: false, default: "v21.0",
    description: "Meta Graph API version",
  },
  "whatsapp.access_token": {
    group: "connection", type: "string", secret: true,
    envFallback: "WHATSAPP_ACCESS_TOKEN",
    description: "Permanent system-user access token",
  },
  "whatsapp.app_secret": {
    group: "connection", type: "string", secret: true,
    envFallback: "WHATSAPP_APP_SECRET",
    description: "Meta app secret, used to verify X-Hub-Signature-256",
  },
  "whatsapp.verify_token": {
    group: "connection", type: "string", secret: true,
    envFallback: "WHATSAPP_VERIFY_TOKEN",
    description: "Webhook verification token configured in Meta",
  },
  "whatsapp.default_language": {
    group: "conversation", type: "string", secret: false, default: "fr",
    allowed: ["fr", "en"],
    description: "Default conversation language",
  },
  "whatsapp.session_timeout_hours": {
    group: "conversation", type: "number", secret: false, default: 24,
    min: 1, max: 168,
    description: "Inactivity window before a conversation expires",
  },
  "whatsapp.message_retention_days": {
    group: "conversation", type: "number", secret: false, default: 180,
    min: 7, max: 3650,
    description: "How long message transcripts are kept (they contain personal data)",
  },
  "whatsapp.max_field_retries": {
    group: "conversation", type: "number", secret: false, default: 3,
    min: 1, max: 10,
    description: "Retries per field before falling back to simpler prompts",
  },
  "whatsapp.escalation_number": {
    group: "conversation", type: "string", secret: false,
    description: "Number offered when a customer asks for a human agent",
  },
  // Names of the templates approved in WhatsApp Manager. Kept as settings rather
  // than constants because approval names change and a rename must not need a
  // deploy. Empty means "that notification is not configured yet".
  "whatsapp.template_language": {
    group: "templates", type: "string", secret: false, default: "fr",
    allowed: ["fr", "en", "fr_FR", "en_GB", "en_US"],
    description: "Locale code registered with the approved templates",
  },
  "whatsapp.template_payment_received": {
    group: "templates", type: "string", secret: false,
    description: "Approved template sent when a payment is confirmed",
  },
  "whatsapp.template_certificate_ready": {
    group: "templates", type: "string", secret: false,
    description: "Approved template sent when the certificate has been issued",
  },
  "whatsapp.template_quote_reminder": {
    group: "templates", type: "string", secret: false,
    description: "Approved template used to follow up an unpaid quote",
  },

  "whatsapp.attribution_user_id": {
    group: "attribution", type: "number", secret: false,
    description: "Account that owns WhatsApp-originated cases and sales",
  },
};

export const SETTING_KEYS = Object.keys(SETTING_REGISTRY);

export function isKnownSettingKey(key) {
  return Object.prototype.hasOwnProperty.call(SETTING_REGISTRY, key);
}

export function keysForGroup(group) {
  return SETTING_KEYS.filter((k) => SETTING_REGISTRY[k].group === group);
}

/** Coerce a stored string into the type the registry declares. */
export function coerceValue(key, raw) {
  const def = SETTING_REGISTRY[key];
  if (!def) return raw;
  if (raw === null || raw === undefined || raw === "") {
    const fromEnv = def.envFallback ? process.env[def.envFallback] : undefined;
    if (fromEnv !== undefined && fromEnv !== "") return coerceRaw(def.type, fromEnv);
    return def.default !== undefined ? def.default : null;
  }
  return coerceRaw(def.type, raw);
}

function coerceRaw(type, raw) {
  switch (type) {
    case "boolean":
      return raw === true || raw === 1 || ["1", "true", "yes", "on"].includes(String(raw).toLowerCase());
    case "number": {
      const n = Number(raw);
      return Number.isFinite(n) ? n : null;
    }
    case "json":
      try {
        return typeof raw === "string" ? JSON.parse(raw) : raw;
      } catch {
        return null;
      }
    default:
      return String(raw);
  }
}

/**
 * Validate an incoming value against the registry.
 * Returns { ok, value, message } — never throws, so the controller can collect
 * every field error in one response instead of failing on the first.
 */
export function validateSettingValue(key, value) {
  const def = SETTING_REGISTRY[key];
  if (!def) return { ok: false, message: `Unknown setting: ${key}` };

  // Explicit null clears the value.
  if (value === null) return { ok: true, value: null };

  if (def.type === "boolean") {
    const b = coerceRaw("boolean", value);
    return { ok: true, value: b ? "1" : "0" };
  }

  if (def.type === "number") {
    const n = Number(value);
    if (!Number.isFinite(n)) return { ok: false, message: `${key} must be a number` };
    if (def.min !== undefined && n < def.min) {
      return { ok: false, message: `${key} must be at least ${def.min}` };
    }
    if (def.max !== undefined && n > def.max) {
      return { ok: false, message: `${key} must be at most ${def.max}` };
    }
    return { ok: true, value: String(n) };
  }

  const s = String(value).trim();
  if (s === "") return { ok: true, value: null };
  if (def.allowed && !def.allowed.includes(s)) {
    return { ok: false, message: `${key} must be one of: ${def.allowed.join(", ")}` };
  }
  if (s.length > 4000) return { ok: false, message: `${key} is too long` };
  return { ok: true, value: s };
}

/**
 * Every registered setting, resolved: secrets decrypted, types coerced, env
 * fallbacks applied. Used by the runtime cache — never returned to a client
 * as-is, because it contains plaintext secrets.
 */
export async function getResolvedSettings() {
  const pool = getPool();
  const [rows] = await pool.query(
    "SELECT setting_key, setting_value, is_secret FROM app_settings"
  );

  const stored = new Map(rows.map((r) => [r.setting_key, r]));
  const out = {};
  const decryptionErrors = [];

  for (const key of SETTING_KEYS) {
    const def = SETTING_REGISTRY[key];
    const row = stored.get(key);
    let raw = row ? row.setting_value : null;

    if (def.secret && raw) {
      try {
        raw = decryptSecret(raw);
      } catch (err) {
        decryptionErrors.push({ key, message: err.message });
        raw = null;
      }
    }
    out[key] = coerceValue(key, raw);
  }

  return { values: out, decryptionErrors };
}

/** Raw rows, for admin display. Secret values are returned still encrypted. */
export async function getSettingRows(keys = SETTING_KEYS) {
  if (!keys.length) return [];
  const pool = getPool();
  const placeholders = keys.map(() => "?").join(",");
  const [rows] = await pool.query(
    `SELECT setting_key, setting_value, value_type, is_secret, description,
            updated_by_user_id, updated_at
     FROM app_settings
     WHERE setting_key IN (${placeholders})`,
    keys
  );
  return rows;
}

/**
 * Upsert a batch of settings in one transaction.
 *
 * `entries` is [{ key, value }] where value is already validated. Secrets are
 * encrypted here so no caller can accidentally persist a plaintext token.
 * Returns the keys that actually changed, for the activity log.
 */
export async function saveSettings(entries, updatedByUserId) {
  if (!entries.length) return [];
  const pool = getPool();
  const conn = await pool.getConnection();
  const changed = [];

  try {
    await conn.beginTransaction();

    for (const { key, value } of entries) {
      const def = SETTING_REGISTRY[key];
      const toStore = def.secret && value !== null ? encryptSecret(value) : value;

      await conn.execute(
        `INSERT INTO app_settings (setting_key, setting_value, value_type, is_secret, description, updated_by_user_id)
         VALUES (?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           setting_value = VALUES(setting_value),
           updated_by_user_id = VALUES(updated_by_user_id)`,
        [
          key,
          toStore,
          def.type,
          def.secret ? 1 : 0,
          def.description || null,
          updatedByUserId || null,
        ]
      );
      changed.push(key);
    }

    await conn.commit();
    return changed;
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

/** Read a single resolved value without warming the whole cache. */
export async function getSettingValue(key) {
  if (!isKnownSettingKey(key)) return null;
  const pool = getPool();
  const [rows] = await pool.query(
    "SELECT setting_value FROM app_settings WHERE setting_key = ? LIMIT 1",
    [key]
  );
  const def = SETTING_REGISTRY[key];
  let raw = rows.length ? rows[0].setting_value : null;
  if (def.secret && raw) {
    try {
      raw = decryptSecret(raw);
    } catch {
      raw = null;
    }
  }
  return coerceValue(key, raw);
}
