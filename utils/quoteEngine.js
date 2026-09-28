// src/utils/quoteEngine.js
//
// Pricing a quote: destination zone → validity tier → age band → premium.
//
// DESIGN RULE: this module must never produce a different number from the web
// app for the same inputs. It therefore does NOT reimplement the premium maths.
// It resolves the destination zone, reorders the plan's pricing columns so the
// zone's column is preferred, and then hands the work to
// computePremiumForCaseDetails() — the exact function the web app and the policy
// edit path already use. Zone support is a pre-processing step, not a second
// pricing engine.
//
import crypto from "crypto";
import { computePremiumForCaseDetails } from "./recomputeSalePremium.js";
import { getAgeFromDateString, getAgePremiumMultiplier, AGE_EXEMPTION_MESSAGE } from "./travelPricing.js";
import { pricingTablesForZone } from "./referenceData.js";
import { daysBetweenInclusive } from "./validators.js";

export const TRAVEL_LIKE_PRODUCTS = ["Travel", "Travel Inbound", "Road travel"];

export function parsePricingRules(raw) {
  if (!raw) return null;
  if (typeof raw === "object") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** QT-7F3A91C4 — same shape as the existing POL-/CERT-/INV- references. */
export function generateQuoteReference() {
  return `QT-${crypto.randomBytes(4).toString("hex").toUpperCase()}`;
}

/**
 * Price one traveller on one plan.
 *
 * @param {object} args
 * @param {object} args.plan             catalogue row (pricing_rules may be JSON text)
 * @param {object|null} args.destination destination_zones row from referenceModel
 * @param {string} [args.startDate]      YYYY-MM-DD
 * @param {string} [args.endDate]        YYYY-MM-DD
 * @param {number} [args.stayDays]       used when explicit dates are not known
 * @param {string} args.dateOfBirth      YYYY-MM-DD
 *
 * @returns {{ok: true, quote: object} | {ok: false, code: string, message: string, details?: object}}
 */
export function computeQuote({ plan, destination = null, startDate = null, endDate = null, stayDays = null, dateOfBirth }) {
  if (!plan) return failure("plan_missing", "No plan was selected");

  let days = stayDays;
  if (days == null && startDate && endDate) {
    days = daysBetweenInclusive(startDate, endDate);
  }
  days = Math.max(1, Number(days) || 0);
  if (!days) return failure("duration_missing", "The length of stay is required");

  const pricingRules = parsePricingRules(plan.pricing_rules);
  const zone = destination?.zone || null;

  // Prefer the destination's zone column; fall back to the plan's first column.
  const { tables: zonedRules, column: zoneColumn, matched: zoneMatched } =
    pricingRules ? pricingTablesForZone(pricingRules, zone) : { tables: null, column: null, matched: false };

  // Age eligibility is checked up front so the customer gets the real reason
  // rather than a generic "no price found".
  const age = getAgeFromDateString(dateOfBirth);
  const ageInfo = getAgePremiumMultiplier(age);
  if (TRAVEL_LIKE_PRODUCTS.includes(plan.product_type) && !ageInfo.eligible) {
    return failure("age_ineligible", AGE_EXEMPTION_MESSAGE, { age, ageBand: ageInfo.band });
  }

  const priced = computePremiumForCaseDetails({
    duration_days: days,
    pricing_rules: zonedRules,
    product_type: plan.product_type,
    plan_fixed_duration_premiums: plan.fixed_duration_premiums ? 1 : 0,
    date_of_birth: dateOfBirth,
    flat_price: plan.flat_price,
  });

  if (!priced.ok) {
    const code = priced.error === AGE_EXEMPTION_MESSAGE ? "age_ineligible" : "no_price_for_inputs";
    return failure(code, priced.error, { age, ageBand: ageInfo.band, zone, zoneColumn });
  }

  return {
    ok: true,
    quote: {
      plan: {
        id: plan.id,
        name: plan.name,
        productType: plan.product_type,
        currency: plan.currency || "XOF",
        coverageSummaryFr: plan.coverage_summary_fr || null,
        coverageSummaryEn: plan.coverage_summary_en || null,
      },
      destination: destination
        ? { code: destination.code, nameEn: destination.name_en, nameFr: destination.name_fr, zone: destination.zone }
        : null,
      zone: { resolved: zone, column: zoneColumn, matchedPlanColumn: zoneMatched },
      travel: { startDate, endDate, stayDays: days, validityDays: priced.validityDays ?? null },
      traveller: { dateOfBirth, age, ageBand: ageInfo.band, ageMultiplier: ageInfo.multiplier },
      pricing: {
        basePremium: priced.basePremium ?? null,
        premium: priced.premium,
        tax: priced.tax,
        total: priced.total,
        currency: plan.currency || "XOF",
      },
    },
  };
}

function failure(code, message, details = undefined) {
  return details ? { ok: false, code, message, details } : { ok: false, code, message };
}

/**
 * Price every plan a customer is allowed to see, cheapest first.
 * Plans that cannot be priced are returned separately so the caller can explain
 * why rather than silently showing a shorter list.
 */
export function computeQuotesForPlans({ plans, destination, startDate, endDate, stayDays, dateOfBirth }) {
  const priced = [];
  const rejected = [];
  for (const plan of plans) {
    const result = computeQuote({ plan, destination, startDate, endDate, stayDays, dateOfBirth });
    if (result.ok) priced.push(result.quote);
    else rejected.push({ planId: plan.id, planName: plan.name, code: result.code, message: result.message });
  }
  priced.sort((a, b) => a.pricing.total - b.pricing.total);
  return { priced, rejected };
}

/**
 * Money for chat and PDFs. Intl with an explicit locale keeps French output
 * looking French (space as the thousands separator, comma as the decimal mark).
 */
export function formatMoney(amount, currency = "XOF", lang = "fr") {
  const n = Number(amount);
  if (!Number.isFinite(n)) return "—";
  const locale = lang === "en" ? "en-US" : "fr-FR";
  const zeroDecimal = ["XOF", "XAF", "BIF", "JPY", "KRW", "RWF", "UGX", "VND", "CLP", "ISK"];
  const digits = zeroDecimal.includes(String(currency).toUpperCase()) ? 0 : 2;
  try {
    return new Intl.NumberFormat(locale, {
      style: "currency",
      currency: String(currency || "XOF").toUpperCase(),
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    }).format(n);
  } catch {
    return `${n.toFixed(digits)} ${currency}`;
  }
}

/** Dates for chat, in the customer's language. */
export function formatDate(ymd, lang = "fr") {
  if (!ymd) return "—";
  const d = new Date(`${String(ymd).slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return String(ymd);
  try {
    return new Intl.DateTimeFormat(lang === "en" ? "en-GB" : "fr-FR", {
      day: "2-digit", month: "long", year: "numeric", timeZone: "UTC",
    }).format(d);
  } catch {
    return String(ymd).slice(0, 10);
  }
}
