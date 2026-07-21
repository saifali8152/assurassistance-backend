/**
 * Recompute billable premium for a confirmed sale from the live catalogue +
 * current case duration and traveller age. Used after policy edits so accounting
 * (sales / invoices / partner invoices) stays aligned with duration & age rules.
 */
import {
  computeTravelPlanPremium,
  extractValidityTiersFromPricing,
  stayDaysToValidityTier,
  getBasePremiumForValidityTier,
  roundMoney,
  AGE_EXEMPTION_MESSAGE,
} from "./travelPricing.js";

function parsePricingRules(raw) {
  if (!raw) return null;
  if (typeof raw === "object") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * @param {object} caseDetails — row from getCaseDetailsById (after update)
 * @returns {{ ok: true, premium: number, tax: number, total: number, validityDays?: number, ageBand?: string, basePremium?: number }
 *   | { ok: false, error: string }}
 */
export function computePremiumForCaseDetails(caseDetails) {
  if (!caseDetails) {
    return { ok: false, error: "Case not found" };
  }

  const stayDays = Math.max(1, Number(caseDetails.duration_days) || 1);
  const pricingRules = parsePricingRules(caseDetails.pricing_rules);
  const productType = caseDetails.product_type || "";
  const travelLike = ["Travel", "Travel Inbound", "Road travel"].includes(productType);
  const fixedDurationPremiums = !!Number(caseDetails.plan_fixed_duration_premiums);

  if (travelLike && pricingRules?.pricing?.length) {
    const comp = computeTravelPlanPremium(pricingRules, stayDays, caseDetails.date_of_birth, {
      fixedDurationPremiums,
    });
    if (comp.error === "age_ineligible") {
      return { ok: false, error: AGE_EXEMPTION_MESSAGE };
    }
    if (comp.planPremium == null) {
      return { ok: false, error: "No matching price found for this duration" };
    }
    const premium = roundMoney(comp.planPremium);
    return {
      ok: true,
      premium,
      tax: 0,
      total: premium,
      validityDays: comp.validityDays,
      ageBand: comp.ageInfo?.band,
      basePremium: comp.basePremium,
    };
  }

  if (pricingRules?.pricing?.length) {
    const tiers = extractValidityTiersFromPricing(pricingRules);
    const validityDays = stayDaysToValidityTier(stayDays, tiers);
    const base = getBasePremiumForValidityTier(pricingRules, validityDays);
    if (base != null) {
      const premium = roundMoney(base);
      return { ok: true, premium, tax: 0, total: premium, validityDays };
    }
  }

  if (caseDetails.flat_price != null && Number(caseDetails.flat_price) > 0) {
    const premium = roundMoney(Number(caseDetails.flat_price) * stayDays);
    return { ok: true, premium, tax: 0, total: premium };
  }

  return { ok: false, error: "Plan pricing information is not available" };
}
