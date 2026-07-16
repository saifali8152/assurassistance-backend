// Commission tiers for partner (travel agency) invoices.
// Commissions are NOT stored on sales: they only appear on partner invoices,
// where they are deducted from the total premium amount.
//
// Tier table (Côte d'Ivoire retail travel product):
//   10 days  — premium 15,000 XOF — commission  4,000 XOF
//   45 days  — premium 30,500 XOF — commission  7,000 XOF
//   93 days  — premium 43,500 XOF — commission 10,000 XOF
//   180 days — premium 60,500 XOF — commission 15,000 XOF
//   365 days — premium 78,000 XOF — commission 18,000 XOF

export const COMMISSION_TIERS = [
  { days: 10, premium: 15000, commission: 4000 },
  { days: 45, premium: 30500, commission: 7000 },
  { days: 93, premium: 43500, commission: 10000 },
  { days: 180, premium: 60500, commission: 15000 },
  { days: 365, premium: 78000, commission: 18000 },
];

/**
 * Resolve the commission for a single sale.
 * Primary match: exact premium amount (the tier premiums are fixed price points).
 * Fallback: coverage duration — the smallest tier that covers the trip length.
 * Returns 0 when neither the premium nor the duration maps to a tier.
 */
export function commissionForSale({ premium, durationDays }) {
  const p = Number(premium);
  if (Number.isFinite(p) && p > 0) {
    const byPremium = COMMISSION_TIERS.find((t) => t.premium === Math.round(p));
    if (byPremium) return byPremium.commission;
  }
  const d = Number(durationDays);
  if (Number.isFinite(d) && d > 0) {
    const byDuration = COMMISSION_TIERS.find((t) => d <= t.days);
    return (byDuration || COMMISSION_TIERS[COMMISSION_TIERS.length - 1]).commission;
  }
  return 0;
}
