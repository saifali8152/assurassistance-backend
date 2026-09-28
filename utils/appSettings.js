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

/** Absolute webhook URL to paste into the Meta dashboard. */
export function getWebhookUrl() {
  const base = (process.env.PUBLIC_API_URL || process.env.BASE_URL || "")
    .replace(/\/+$/, "");
  return base ? `${base}/api/whatsapp/webhook` : "/api/whatsapp/webhook";
}
