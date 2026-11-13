// src/utils/appSettings.js
//
// Runtime access to superadmin-managed configuration, with a short-lived cache.
//
// WHY A CACHE AT ALL: every inbound WhatsApp webhook needs the access token,
// phone number id and app secret. Reading four rows per message would put a
// pointless query on the hottest path in the module.
//
// WHY THE TTL IS SHORT: production runs behind PM2 and may have more than one
// worker. An explicit invalidate() only clears the cache in the process that
// handled the save, so the other workers would keep serving stale credentials.
// A 30-second TTL bounds that window without polling. Saving in the UI is
// therefore "live" for the worker that saved and "live within 30s" everywhere
// else — and the operator never has to restart the server.
//
import {
  getResolvedSettings,
  SETTING_REGISTRY,
  coerceValue,
} from "../models/settingsModel.js";

const CACHE_TTL_MS = 30_000;

let cache = null;
let cachedAt = 0;
let inFlight = null;
let lastDecryptionErrors = [];

/** Load (or reuse) the resolved settings map. */
export async function loadSettings({ force = false } = {}) {
  const fresh = cache && Date.now() - cachedAt < CACHE_TTL_MS;
  if (fresh && !force) return cache;

  // Collapse concurrent misses into a single query.
  if (inFlight) return inFlight;

  inFlight = (async () => {
    try {
      const { values, decryptionErrors } = await getResolvedSettings();
      cache = values;
      cachedAt = Date.now();
      lastDecryptionErrors = decryptionErrors;
      if (decryptionErrors.length) {
        console.warn(
          "app_settings: could not decrypt",
          decryptionErrors.map((e) => e.key).join(", "),
          "— check SETTINGS_ENCRYPTION_KEY"
        );
      }
      return cache;
    } catch (err) {
      // Never let a settings read take down a request. Fall back to defaults and
      // environment variables so the app behaves as it did before this module.
      console.error("app_settings: load failed, using defaults/env:", err.message);
      if (!cache) {
        cache = Object.fromEntries(
          Object.keys(SETTING_REGISTRY).map((k) => [k, coerceValue(k, null)])
        );
        cachedAt = Date.now();
      }
      return cache;
    } finally {
      inFlight = null;
    }
  })();

  return inFlight;
}

/** Drop the cache so the next read hits the database. Call after every save. */
export function invalidateSettings() {
  cache = null;
  cachedAt = 0;
}

export function getDecryptionErrors() {
  return lastDecryptionErrors;
}

export async function getSetting(key) {
  const all = await loadSettings();
  return all[key] ?? null;
}

/**
 * The WhatsApp runtime configuration, in one object, with a `ready` flag the
 * webhook uses to decide whether it can talk to Meta at all.
 */
export async function getWhatsAppConfig() {
  const s = await loadSettings();
  const cfg = {
    enabled: Boolean(s["whatsapp.enabled"]),
    phoneNumberId: s["whatsapp.phone_number_id"] || null,
    wabaId: s["whatsapp.waba_id"] || null,
    businessNumber: s["whatsapp.business_number"] || null,
    apiVersion: s["whatsapp.api_version"] || "v21.0",
    accessToken: s["whatsapp.access_token"] || null,
    appSecret: s["whatsapp.app_secret"] || null,
    verifyToken: s["whatsapp.verify_token"] || null,
    defaultLanguage: s["whatsapp.default_language"] === "en" ? "en" : "fr",
    sessionTimeoutHours: Number(s["whatsapp.session_timeout_hours"]) || 24,
    messageRetentionDays: Number(s["whatsapp.message_retention_days"]) || 180,
    maxFieldRetries: Number(s["whatsapp.max_field_retries"]) || 3,
    escalationNumber: s["whatsapp.escalation_number"] || null,
    attributionUserId: s["whatsapp.attribution_user_id"] || null,
    // Template names were registered in Milestone 2 but never exposed here, so
    // nothing could send one. Milestone 3 needs them: once the 24-hour window
    // closes, a payment confirmation can only go out as an approved template.
    templateLanguage: s["whatsapp.template_language"] || "fr",
    templatePaymentReceived: s["whatsapp.template_payment_received"] || null,
    templateCertificateReady: s["whatsapp.template_certificate_ready"] || null,
    templateQuoteReminder: s["whatsapp.template_quote_reminder"] || null,
  };

  cfg.missing = [
    !cfg.phoneNumberId && "phone_number_id",
    !cfg.accessToken && "access_token",
    !cfg.appSecret && "app_secret",
    !cfg.verifyToken && "verify_token",
  ].filter(Boolean);

  /** Can we send and receive right now? */
  cfg.ready = cfg.enabled && cfg.missing.length === 0;

  return cfg;
}

/**
 * Document number formats, with the registry defaults applied.
 *
 * Read on every sale, so it rides the same 30-second cache as everything else:
 * an operator changing the prefix sees it take effect within half a minute
 * without a restart.
 */
export async function getNumberFormats() {
  const s = await loadSettings();
  return {
    policy: s["policy.number_format"] || "AA-{YYYY}-{SEQ:6}",
    invoice: s["policy.invoice_format"] || "INV-{YYYY}-{SEQ:6}",
    certificate: s["policy.certificate_format"] || "CERT-{YYYY}-{SEQ:6}",
  };
}

/** Absolute webhook URL to paste into the Meta dashboard. */
export function getWebhookUrl() {
  const base = (process.env.PUBLIC_API_URL || process.env.BASE_URL || "")
    .replace(/\/+$/, "");
  return base ? `${base}/api/whatsapp/webhook` : "/api/whatsapp/webhook";
}

/**
 * Claims configuration (Milestone 4) — every rule the client controls, with the
 * registry defaults applied, in the shape the claims code wants.
 */
export async function getClaimsConfig() {
  const s = await loadSettings();
  const num = (k, d) => {
    const n = Number(s[k]);
    return s[k] === null || s[k] === undefined || s[k] === "" || !Number.isFinite(n) ? d : n;
  };
  const words = (k) =>
    String(s[k] || "").split(",").map((w) => w.trim().toLowerCase()).filter(Boolean);
  return {
    numberFormat: s["claims.number_format"] || "SIN-{YYYY}-{SEQ:6}",
    descriptionMin: num("claims.description_min_chars", 20),
    descriptionMax: num("claims.description_max_chars", 1500),
    cardNumberMode: ["certificate", "separate", "none"].includes(s["claims.card_number_mode"])
      ? s["claims.card_number_mode"] : "certificate",
    cardNumberPattern: s["claims.card_number_pattern"] || null,
    maxAttempts: num("claims.validation_max_attempts", 3),
    lockoutMinutes: num("claims.validation_lockout_minutes", 30),
    maxPerPolicy: num("claims.validation_max_per_policy", 5),
    expiryRule: s["claims.expiry_rule"] === "today" ? "today" : "incident_date",
    filingWindowDays: s["claims.filing_window_days"] === null || s["claims.filing_window_days"] === undefined || s["claims.filing_window_days"] === ""
      ? null : num("claims.filing_window_days", null),
    unpaidPolicies: s["claims.unpaid_policies"] === "refuse" ? "refuse" : "allow_flag",
    uncoveredClaimType: s["claims.uncovered_claim_type"] === "refuse" ? "refuse" : "flag",
    maxDocuments: num("claims.max_documents", 10),
    maxFileMb: num("claims.max_file_mb", 10),
    draftAbandonHours: num("claims.draft_abandon_hours", 48),
    retentionDays: s["claims.document_retention_days"] ? num("claims.document_retention_days", null) : null,
    notificationEmails: String(s["claims.notification_emails"] || "")
      .split(/[,;\s]+/).map((e) => e.trim()).filter(Boolean),
    urgentKeywords: { fr: words("claims.urgent_keywords_fr"), en: words("claims.urgent_keywords_en") },
    consentText: { fr: s["claims.consent_text_fr"] || null, en: s["claims.consent_text_en"] || null },
    confirmationText: { fr: s["claims.confirmation_text_fr"] || null, en: s["claims.confirmation_text_en"] || null },
  };
}
