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
import { validateFormat } from "../utils/documentNumbers.js";

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

  // ---- Document numbering ---------------------------------------------------
  // The insurer's prefix and any regulatory sequence rule are the client's to
  // decide, so these are settings rather than constants. `validator` rejects a
  // format with no sequence token, which would otherwise collide on every row.
  "policy.number_format": {
    group: "numbering", type: "string", secret: false, default: "AA-{YYYY}-{SEQ:6}",
    validator: validateFormat,
    description: "Policy number format. Tokens: {YYYY} {YY} {MM} {SEQ:n}",
  },
  "policy.invoice_format": {
    group: "numbering", type: "string", secret: false, default: "INV-{YYYY}-{SEQ:6}",
    validator: validateFormat,
    description: "Invoice number format, same tokens",
  },
  "policy.certificate_format": {
    group: "numbering", type: "string", secret: false, default: "CERT-{YYYY}-{SEQ:6}",
    validator: validateFormat,
    description: "Certificate number format, same tokens",
  },

  // ---- Company identity -----------------------------------------------------
  // Printed on certificates and invoices. These were hardcoded in the PDF
  // modules, so changing the insurer's address meant a deploy.
  "company.legal_name": {
    group: "company", type: "string", secret: false,
    description: "Legal name exactly as registered",
  },
  "company.address": {
    group: "company", type: "string", secret: false,
    description: "Registered address, one line",
  },
  "company.phone": {
    group: "company", type: "string", secret: false,
    description: "Contact number printed on documents",
  },
  "company.email": {
    group: "company", type: "string", secret: false,
    description: "Contact email printed on documents",
  },
  "company.website": {
    group: "company", type: "string", secret: false,
    description: "Website printed on documents",
  },

  // ---- Certificate wording --------------------------------------------------
  // Supplied by the insurer, in both languages, and legally theirs to word.
  "certificate.footer_fr": {
    group: "certificate", type: "string", secret: false,
    description: "Footer line on the French certificate",
  },
  "certificate.footer_en": {
    group: "certificate", type: "string", secret: false,
    description: "Footer line on the English certificate",
  },
  "certificate.terms_fr": {
    group: "certificate", type: "string", secret: false,
    description: "Policy terms paragraph, French",
  },
  "certificate.terms_en": {
    group: "certificate", type: "string", secret: false,
    description: "Policy terms paragraph, English",
  },
  "certificate.signature_name": {
    group: "certificate", type: "string", secret: false,
    description: "Name printed in the signature block",
  },
  "certificate.signature_title": {
    group: "certificate", type: "string", secret: false,
    description: "Title printed under the signature",
  },

  // ---- Payments, shared -----------------------------------------------------
  "payment.enabled": {
    group: "payment_status", type: "boolean", secret: false, default: false,
    description: "Master switch for in-conversation payment",
  },
  "payment.currency": {
    group: "payment_status", type: "string", secret: false, default: "XOF",
    allowed: ["XOF", "XAF", "USD", "EUR"],
    description: "Currency charged at the provider",
  },
  "payment.timeout_minutes": {
    group: "payment_status", type: "number", secret: false, default: 15, min: 2, max: 120,
    description: "How long a pending payment waits before it is marked expired",
  },
  "payment.countries": {
    group: "payment_status", type: "string", secret: false,
    description: "ISO country codes the payment step is offered in, comma separated",
  },
  "payment.settlement_note": {
    group: "payment_status", type: "string", secret: false,
    description: "Free note on where funds settle, for the operator's own reference",
  },
};


/**
 * The mobile money providers the payment module can talk to.
 *
 * Each one needs the same shape of configuration, so the registry entries are
 * generated rather than copied four times: a field added here appears for every
 * provider, and none of them can silently fall behind.
 *
 * Everything here is supplied by the client from the admin screen. None of it
 * belongs in .env — the credentials are the insurer's, and they change without
 * a deploy.
 */
export const PAYMENT_PROVIDERS = [
  { code: "orange", label: "Orange Money" },
  { code: "mtn", label: "MTN MoMo" },
  { code: "wave", label: "Wave" },
  { code: "moov", label: "Moov Money" },
];

const PROVIDER_FIELDS = [
  { suffix: "enabled", type: "boolean", secret: false, def: false, desc: "Offer this provider to customers" },
  { suffix: "label", type: "string", secret: false, desc: "Name shown to the customer in the chat" },
  { suffix: "countries", type: "string", secret: false, desc: "ISO country codes this provider covers, comma separated" },
  { suffix: "msisdn_prefixes", type: "string", secret: false, desc: "Valid number prefixes, comma separated, e.g. 07,08" },
  { suffix: "base_url", type: "string", secret: false, desc: "API base URL for the chosen environment" },
  { suffix: "merchant_id", type: "string", secret: false, desc: "Merchant or collection account identifier" },
  { suffix: "api_user", type: "string", secret: false, desc: "API user / client id issued by the provider" },
  { suffix: "api_key", type: "string", secret: true, desc: "API key / client secret" },
  { suffix: "subscription_key", type: "string", secret: true, desc: "Subscription key, where the provider issues one" },
  { suffix: "callback_secret", type: "string", secret: true, desc: "Shared secret used to verify callback signatures" },
  { suffix: "settlement_account", type: "string", secret: false, desc: "Account funds settle into, for reconciliation" },
];

for (const provider of PAYMENT_PROVIDERS) {
  for (const f of PROVIDER_FIELDS) {
    SETTING_REGISTRY[`payment.${provider.code}.${f.suffix}`] = {
      group: `provider_${provider.code}`,
      type: f.type,
      secret: f.secret,
      ...(f.def !== undefined ? { default: f.def } : {}),
      description: `${provider.label} — ${f.desc}`,
    };
  }
}

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
  if (typeof def.validator === "function") {
    const r = def.validator(s);
    if (!r.ok) return { ok: false, message: `${key}: ${r.message}` };
  }
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
