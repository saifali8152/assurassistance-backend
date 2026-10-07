// src/utils/payments/config.js
//
// Turns the flat `payment.*` settings into per-provider configuration objects.
//
// Everything here comes from the admin screen, never from .env: the credentials
// belong to the insurer, and the countries a provider covers change as its
// merchant account is approved market by market.
//
import { loadSettings } from "../appSettings.js";
import { PAYMENT_PROVIDERS } from "../../models/settingsModel.js";

/** Comma or space separated setting into a clean upper-case list. */
function parseList(raw) {
  if (!raw) return [];
  return String(raw)
    .split(/[,\s]+/)
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
}

/**
 * One provider's resolved configuration, plus a `missing` list so the admin
 * screen can say exactly what is still needed rather than just "not ready".
 */
function providerConfig(settings, { code, label }) {
  const get = (suffix) => settings[`payment.${code}.${suffix}`] ?? null;

  const cfg = {
    code,
    label: get("label") || label,
    enabled: Boolean(get("enabled")),
    countries: parseList(get("countries")),
    msisdnPrefixes: parseList(get("msisdn_prefixes")),
    baseUrl: get("base_url"),
    merchantId: get("merchant_id"),
    apiUser: get("api_user"),
    apiKey: get("api_key"),
    subscriptionKey: get("subscription_key"),
    callbackSecret: get("callback_secret"),
    settlementAccount: get("settlement_account"),
  };

  // What a live payment needs. Deliberately not `subscriptionKey`: only some
  // providers issue one, so requiring it would mark three of four permanently
  // unready.
  cfg.missing = [
    !cfg.baseUrl && "base_url",
    !cfg.apiKey && "api_key",
    !cfg.callbackSecret && "callback_secret",
    cfg.countries.length === 0 && "countries",
  ].filter(Boolean);

  cfg.ready = cfg.enabled && cfg.missing.length === 0;
  return cfg;
}

/** The whole payment configuration, resolved. */
export async function getPaymentConfig() {
  const s = await loadSettings();
  const providers = PAYMENT_PROVIDERS.map((p) => providerConfig(s, p));

  return {
    enabled: Boolean(s["payment.enabled"]),
    currency: s["payment.currency"] || "XOF",
    timeoutMinutes: Number(s["payment.timeout_minutes"]) || 15,
    countries: parseList(s["payment.countries"]),
    providers,
    /** Ready to take money from at least one provider. */
    get ready() {
      return this.enabled && providers.some((p) => p.ready);
    },
  };
}

/** One provider's config, or null when it is not configured at all. */
export async function getProviderConfig(code) {
  const cfg = await getPaymentConfig();
  return cfg.providers.find((p) => p.code === String(code || "").toLowerCase()) || null;
}

/**
 * The providers that may be offered to a customer in a given country.
 *
 * A provider with no country list is NOT offered everywhere — it is offered
 * nowhere, because an unconfigured provider silently accepting every customer
 * is how a payment goes to the wrong market.
 */
export async function providersForCountry(countryCode) {
  const cfg = await getPaymentConfig();
  const want = String(countryCode || "").trim().toUpperCase();
  if (!cfg.enabled) return [];
  return cfg.providers.filter((p) => p.ready && (!want || p.countries.includes(want)));
}

export const __testables = { parseList, providerConfig };
