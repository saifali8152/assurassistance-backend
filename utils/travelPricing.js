/** Default GNA Retail-style validity tiers (days of cover purchased). */
export const VALIDITY_TIERS = [10, 45, 93, 180, 365];

export function parseDaysFromPricingLabel(label) {
  if (label == null) return null;
  const s = String(label);
  const match = s.match(/(\d+)\s*(?:Days|Jours|days|jours)/i);
  if (match) return parseInt(match[1], 10);
  if (/year|an/i.test(s)) return 365;
  return null;
}

/** Prefer the plan's own pricing-row durations; fall back to the GNA defaults. */
export function extractValidityTiersFromPricing(pricingTables) {
  if (!pricingTables || !Array.isArray(pricingTables.pricing) || pricingTables.pricing.length === 0) {
    return [...VALIDITY_TIERS];
  }
  const days = pricingTables.pricing
    .map((row) => parseDaysFromPricingLabel(row.label))
    .filter((d) => d != null && d > 0);
  const unique = [...new Set(days)].sort((a, b) => a - b);
  return unique.length ? unique : [...VALIDITY_TIERS];
}

/**
 * Map actual stay length to the smallest plan duration that covers it.
 * Tiers default to VALIDITY_TIERS; pass the plan's own rows for Agico Burundi (32/63, …).
 */
export function stayDaysToValidityTier(stayDays, tiers = VALIDITY_TIERS) {
  const list = tiers?.length ? tiers : VALIDITY_TIERS;
  const d = Math.max(1, Math.floor(Number(stayDays)) || 1);
  for (const tier of list) {
    if (d <= tier) return tier;
  }
  return list[list.length - 1];
}

function pickPriceFromRow(row, columns) {
  if (!row?.columns) return null;
  for (const col of columns) {
    const price = row.columns[col];
    if (price !== null && price !== undefined && !Number.isNaN(Number(price))) {
      return Number(price);
    }
  }
  return null;
}

/**
 * Premium for a validity tier: exact row match, else smallest tier ≥ validity, else largest ≤ validity, else closest by days.
 */
export function getBasePremiumForValidityTier(pricingTables, validityDays) {
  if (!pricingTables || !Array.isArray(pricingTables.pricing) || pricingTables.pricing.length === 0) {
    return null;
  }
  const columns = pricingTables.pricingColumns || [];
  const target = pricingTables.pricing.find((row) => parseDaysFromPricingLabel(row.label) === validityDays);
  if (target) {
    const p = pickPriceFromRow(target, columns);
    if (p != null) return p;
  }

  const scored = pricingTables.pricing
    .map((row) => ({ row, days: parseDaysFromPricingLabel(row.label) }))
    .filter((x) => x.days != null);
  if (!scored.length) return null;

  const ge = scored.filter((x) => x.days >= validityDays).sort((a, b) => a.days - b.days)[0];
  if (ge) {
    const p = pickPriceFromRow(ge.row, columns);
    if (p != null) return p;
  }
  const le = scored.filter((x) => x.days <= validityDays).sort((a, b) => b.days - a.days)[0];
  if (le) {
    const p = pickPriceFromRow(le.row, columns);
    if (p != null) return p;
  }
  const closest = scored.sort(
    (a, b) => Math.abs(a.days - validityDays) - Math.abs(b.days - validityDays)
  )[0];
  return pickPriceFromRow(closest.row, columns);
}

export function getAgeFromDateString(dobStr, refDate = new Date()) {
  if (!dobStr || String(dobStr).trim() === "") return null;
  const d = new Date(dobStr);
  if (Number.isNaN(d.getTime())) return null;
  const today = new Date(refDate);
  let age = today.getFullYear() - d.getFullYear();
  const m = today.getMonth() - d.getMonth();
  if (m < 0 || (m === 0 && today.getDate() < d.getDate())) age--;
  return age;
}

/**
 * Age bands (non-overlapping):
 * - under 16: ÷2
 * - 16–75: ×1
 * - 76–80: ×2
 * - 81–85: ×4
 * - over 85: ineligible
 */
export function getAgePremiumMultiplier(age) {
  if (age === null || age === undefined) {
    return { multiplier: 1, eligible: true, band: "unknown" };
  }
  if (age < 16) return { multiplier: 0.5, eligible: true, band: "child" };
  if (age <= 75) return { multiplier: 1, eligible: true, band: "standard" };
  if (age <= 80) return { multiplier: 2, eligible: true, band: "senior76_80" };
  if (age <= 85) return { multiplier: 4, eligible: true, band: "senior81_85" };
  return { multiplier: null, eligible: false, band: "ineligible" };
}

export function roundMoney(n) {
  return Math.round(Number(n) * 100) / 100;
}

/**
 * @param {object} [opts]
 * @param {boolean} [opts.fixedDurationPremiums] — exact table price, no age multipliers (Agico Burundi).
 */
export function computeTravelPlanPremium(pricingTables, stayDays, dateOfBirth, opts = {}) {
  const tiers = extractValidityTiersFromPricing(pricingTables);
  const validityDays = stayDaysToValidityTier(stayDays, tiers);
  const base = getBasePremiumForValidityTier(pricingTables, validityDays);
  if (base === null) {
    return {
      error: "no_price_for_tier",
      validityDays,
      planPremium: null,
      fixedDurationPremiums: !!opts.fixedDurationPremiums,
    };
  }

  if (opts.fixedDurationPremiums) {
    return {
      validityDays,
      basePremium: base,
      age: getAgeFromDateString(dateOfBirth),
      ageInfo: { multiplier: 1, eligible: true, band: "fixed_table" },
      planPremium: roundMoney(base),
      fixedDurationPremiums: true,
    };
  }

  const age = getAgeFromDateString(dateOfBirth);
  const ageInfo = getAgePremiumMultiplier(age);
  if (!ageInfo.eligible) {
    return {
      error: "age_ineligible",
      validityDays,
      basePremium: base,
      age,
      ageInfo,
      planPremium: null,
      fixedDurationPremiums: false,
    };
  }
  return {
    validityDays,
    basePremium: base,
    age,
    ageInfo,
    planPremium: roundMoney(base * ageInfo.multiplier),
    fixedDurationPremiums: false,
  };
}
