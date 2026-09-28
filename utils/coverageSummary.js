// src/utils/coverageSummary.js
//
// Turning a plan's `guarantees` into the coverage lines shown in a WhatsApp quote.
//
// WHY DERIVE RATHER THAN ASK SOMEONE TO WRITE IT:
// `catalogue.pricing_rules.guarantees` is already structured — category, coverage
// type and amount — and every coverage-type label already exists in French and
// English in the web app's translations. Asking an operator to hand-write a
// second description per plan would create a copy that silently goes stale the
// first time a guarantee changes. This module is the same decision as reading
// country names from `destination_zones`: one source of truth.
//
// `catalogue.coverage_summary_fr` / `_en` remain as a manual override for the
// cases where the derived text reads badly — the caller prefers those when set.
//
// The labels below are copied verbatim from
// frontend/src/locales/{fr,en}/translation.json (the `plan.*` keys), so chat,
// web and certificate wording cannot drift apart.
//
import { formatMoney } from "./quoteEngine.js";

const COVERAGE_LABELS = {
  fr: {
    medicalEmergencies: "Urgences médicales et Dépenses associées",
    medicalTransport: "Transport sanitaire",
    hospitalization: "Hospitalisation",
    evacuationRepatriation: "Frais d'évacuation et de rapatriement d'urgence",
    bodyRepatriation: "Rapatriement de corps",
    tripCancellation: "Annulation de voyage",
    baggageDeliveryDelay: "Retard de livraison de bagages",
    passportLoss: "Perte de passeport",
    civilLiability: "Responsabilité civile",
    legalAssistance: "Assistance juridique",
    bail: "Caution",
  },
  en: {
    medicalEmergencies: "Medical Emergencies and Associated Expenses",
    medicalTransport: "Medical Transport",
    hospitalization: "Hospitalization",
    evacuationRepatriation: "Emergency Evacuation and Repatriation Expenses",
    bodyRepatriation: "Body Repatriation",
    tripCancellation: "Trip Cancellation",
    baggageDeliveryDelay: "Baggage Delivery Delay",
    passportLoss: "Passport Loss",
    civilLiability: "Civil Liability",
    legalAssistance: "Legal Assistance",
    bail: "Bail",
  },
};

const CATEGORY_LABELS = {
  fr: {
    MEDICAL: "MEDICAL",
    TRAVEL: "VOYAGE",
    JURIDICAL: "JURIDIQUE",
  },
  en: {
    MEDICAL: "MEDICAL",
    TRAVEL: "TRAVEL",
    JURIDICAL: "JURIDICAL",
  },
};

/** Order guarantees are presented in, matching the web app's plan card. */
const CATEGORY_ORDER = ["MEDICAL", "TRAVEL", "JURIDICAL"];

function parseRules(raw) {
  if (!raw) return null;
  if (typeof raw === "object") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function coverageLabel(coverageType, lang = "fr") {
  const table = COVERAGE_LABELS[lang === "en" ? "en" : "fr"];
  return table[coverageType] || COVERAGE_LABELS.fr[coverageType] || coverageType;
}

/**
 * A short bullet list of the plan's headline guarantees.
 *
 * Guarantees WITH an amount come first, because a limit is what a customer
 * actually weighs; unlimited ones ("legal assistance", no figure) fill the
 * remaining slots. Capped at `max` lines so the quote message stays inside a
 * comfortable WhatsApp bubble.
 *
 * @param {object|string} pricingRules  catalogue.pricing_rules (object or JSON text)
 * @param {object} [opts]
 * @param {'fr'|'en'} [opts.lang]
 * @param {string} [opts.currency]      currency the amounts are expressed in
 * @param {number} [opts.max]           maximum lines
 * @returns {string|null} null when the plan carries no guarantees
 */
export function buildCoverageSummary(pricingRules, { lang = "fr", currency = "XOF", max = 4 } = {}) {
  const rules = parseRules(pricingRules);
  const guarantees = Array.isArray(rules?.guarantees) ? rules.guarantees : [];
  if (!guarantees.length) return null;

  const byCategory = (g) => {
    const i = CATEGORY_ORDER.indexOf(String(g.category || "").toUpperCase());
    return i === -1 ? CATEGORY_ORDER.length : i;
  };

  const withAmount = guarantees.filter((g) => g.amount !== null && g.amount !== undefined);
  const withoutAmount = guarantees.filter((g) => g.amount === null || g.amount === undefined);

  const chosen = [...withAmount, ...withoutAmount]
    .sort((a, b) => byCategory(a) - byCategory(b))
    .slice(0, Math.max(1, max));

  const lines = chosen.map((g) => {
    const label = coverageLabel(g.coverageType, lang);
    if (g.amount === null || g.amount === undefined) return `• ${label}`;
    return `• ${label} : ${formatMoney(g.amount, currency, lang)}`;
  });

  return lines.join("\n");
}

/**
 * The full guarantee list grouped by category, for a screen or a document that
 * has room for it. Not used by the chat quote, which needs to stay short.
 */
export function buildCoverageBreakdown(pricingRules, { lang = "fr", currency = "XOF" } = {}) {
  const rules = parseRules(pricingRules);
  const guarantees = Array.isArray(rules?.guarantees) ? rules.guarantees : [];
  if (!guarantees.length) return [];

  const catLabels = CATEGORY_LABELS[lang === "en" ? "en" : "fr"];

  return CATEGORY_ORDER.map((category) => {
    const rows = guarantees
      .filter((g) => String(g.category || "").toUpperCase() === category)
      .map((g) => ({
        coverageType: g.coverageType,
        label: coverageLabel(g.coverageType, lang),
        amount: g.amount ?? null,
        amountFormatted: g.amount === null || g.amount === undefined ? null : formatMoney(g.amount, currency, lang),
      }));
    return rows.length ? { category, label: catLabels[category] || category, rows } : null;
  }).filter(Boolean);
}
