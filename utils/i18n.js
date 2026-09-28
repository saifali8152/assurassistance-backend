// src/utils/i18n.js
//
// Server-side translation for WhatsApp copy.
//
// The web app has react-i18next; the backend had nothing, not even for emails.
// Every string a customer reads over WhatsApp comes from i18n/fr.json or
// i18n/en.json — there are no hardcoded sentences in the flow, which is what
// makes "run the whole journey in English" a configuration change rather than a
// code change.
//
// FRENCH IS THE DEFAULT and also the fallback: if an English key is ever missing,
// the customer sees correct French rather than a raw key.
//
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const I18N_DIR = path.join(__dirname, "..", "i18n");

export const DEFAULT_LANGUAGE = "fr";
export const SUPPORTED_LANGUAGES = ["fr", "en"];

const bundles = new Map();

function loadBundle(lang) {
  if (bundles.has(lang)) return bundles.get(lang);
  try {
    const raw = fs.readFileSync(path.join(I18N_DIR, `${lang}.json`), "utf8");
    const parsed = JSON.parse(raw);
    bundles.set(lang, parsed);
    return parsed;
  } catch (err) {
    console.error(`i18n: could not load ${lang}.json:`, err.message);
    bundles.set(lang, {});
    return {};
  }
}

/** Test/ops hook: pick up edited copy without a restart. */
export function reloadBundles() {
  bundles.clear();
}

export function normalizeLanguage(lang) {
  const s = String(lang || "").toLowerCase().slice(0, 2);
  return SUPPORTED_LANGUAGES.includes(s) ? s : DEFAULT_LANGUAGE;
}

function lookup(bundle, key) {
  return key.split(".").reduce((acc, part) => (acc && typeof acc === "object" ? acc[part] : undefined), bundle);
}

/**
 * Translate a dotted key.
 *
 * @param {string} key      e.g. "step.gender.prompt"
 * @param {string} lang     "fr" | "en"
 * @param {object} vars     {{name}} placeholders
 * @param {string} fallback used when the key is missing in BOTH languages
 */
export function t(key, lang = DEFAULT_LANGUAGE, vars = {}, fallback = null) {
  const language = normalizeLanguage(lang);

  let value = lookup(loadBundle(language), key);
  if (value === undefined && language !== DEFAULT_LANGUAGE) {
    value = lookup(loadBundle(DEFAULT_LANGUAGE), key);
  }
  if (value === undefined) {
    if (fallback !== null) return interpolate(fallback, vars);
    console.warn(`i18n: missing key "${key}"`);
    return key;
  }
  if (Array.isArray(value)) return value.map((v) => interpolate(String(v), vars));
  return interpolate(String(value), vars);
}

/** Bound translator, so flow code reads t("key", vars) instead of repeating lang. */
export function translator(lang) {
  const language = normalizeLanguage(lang);
  const fn = (key, vars = {}, fallback = null) => t(key, language, vars, fallback);
  fn.lang = language;
  return fn;
}

function interpolate(template, vars) {
  if (!vars || typeof vars !== "object") return template;
  return template.replace(/\{\{(\w+)\}\}/g, (match, name) =>
    Object.prototype.hasOwnProperty.call(vars, name) && vars[name] !== null && vars[name] !== undefined
      ? String(vars[name])
      : match
  );
}

/**
 * Every key present in French, for the completeness check in the test suite.
 * A missing English key is a translation gap worth failing a build over.
 */
export function flattenKeys(lang = DEFAULT_LANGUAGE, bundle = null, prefix = "") {
  const source = bundle || loadBundle(normalizeLanguage(lang));
  const keys = [];
  for (const [k, v] of Object.entries(source)) {
    const full = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object" && !Array.isArray(v)) keys.push(...flattenKeys(lang, v, full));
    else keys.push(full);
  }
  return keys;
}
