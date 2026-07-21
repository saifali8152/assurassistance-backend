// Commission tiers for partner (travel agency) invoices.
// Commissions are NOT stored on sales: they only appear on partner invoices,
// where they are deducted from the total premium amount.
//
// Tier table (Côte d'Ivoire retail travel product) — base (adult) amounts:
//   10 days  — premium 15,000 XOF — commission  4,000 XOF
//   45 days  — premium 30,500 XOF — commission  7,000 XOF
//   93 days  — premium 43,500 XOF — commission 10,000 XOF
//   180 days — premium 60,500 XOF — commission 15,000 XOF
//   365 days — premium 78,000 XOF — commission 18,000 XOF
//
// Age rules (same for all plans):
//   • under 16 → commission ÷ 2
//   • senior premium surcharges (×2 / ×4) do NOT increase commission

import { getAgeCommissionMultiplier, getAgeFromDateString } from "./travelPricing.js";

export const COMMISSION_TIERS = [
  { days: 10, premium: 15000, commission: 4000 },
  { days: 45, premium: 30500, commission: 7000 },
  { days: 93, premium: 43500, commission: 10000 },
  { days: 180, premium: 60500, commission: 15000 },
  { days: 365, premium: 78000, commission: 18000 },
];

/**
 * Resolve the base (adult) commission for a sale from the duration / base premium table.
 * Prefer matching the pre-age base premium when provided, so age-adjusted sale amounts
 * still map to the correct tier.
 */
export function baseCommissionForSale({ premium, basePremium, durationDays }) {
  const candidates = [basePremium, premium]
    .map((v) => Number(v))
    .filter((p) => Number.isFinite(p) && p > 0);
  for (const p of candidates) {
    const byPremium = COMMISSION_TIERS.find((t) => t.premium === Math.round(p));
    if (byPremium) return byPremium.commission;
    // Child half-premium (e.g. 7500) → recover adult tier
    const doubled = COMMISSION_TIERS.find((t) => t.premium === Math.round(p * 2));
    if (doubled) return doubled.commission;
  }
  const d = Number(durationDays);
  if (Number.isFinite(d) && d > 0) {
    const byDuration = COMMISSION_TIERS.find((t) => d <= t.days);
    return (byDuration || COMMISSION_TIERS[COMMISSION_TIERS.length - 1]).commission;
  }
  return 0;
}

/**
 * Final commission after age factor.
 * @param {{ premium?: number, basePremium?: number, durationDays?: number, dateOfBirth?: string|null, age?: number|null }} args
 */
export function commissionForSale(args = {}) {
  const base = baseCommissionForSale(args);
  if (!base) return 0;
  const age =
    args.age != null && Number.isFinite(Number(args.age))
      ? Number(args.age)
      : getAgeFromDateString(args.dateOfBirth);
  const factor = getAgeCommissionMultiplier(age);
  return Math.round(base * factor);
}
