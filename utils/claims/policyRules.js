// utils/claims/policyRules.js
//
// Milestone 4, Day 2 — what a found policy is allowed to claim.
//
// Pure functions: no database, no clock of their own (`today` is passed in), so
// every rule the client can configure is tested as a rule. The lookup that
// finds the policy lives in models/claimPolicyLookup.js; this file only judges
// what it found.
//
// THE RULES, AND WHO SETS THEM (Admin → Settings → Claims)
//   claims.expiry_rule        incident_date (default) — a policy that has since
//                             expired can still claim for an incident that
//                             happened while it was in force; today — it must
//                             be in force on the day the claim is filed.
//   claims.filing_window_days empty (default) — no limit; N — the incident must
//                             be no more than N days before the claim is filed.
//   claims.unpaid_policies    allow_flag (default) | refuse
//   claims.uncovered_claim_type flag (default) | refuse
//
// A cancelled policy can never claim. That is not a setting.
//

/** Dates come back from MySQL as local-midnight Date objects, and from JSON
 *  snapshots as either "YYYY-MM-DD" or an ISO timestamp of that local midnight.
 *  All three become the same "YYYY-MM-DD" here. */
export function toYmd(value) {
  if (value == null || value === "") return null;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`;
  }
  const s = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : toYmd(d);
}

/** Whole days from a to b ("YYYY-MM-DD"), b − a. */
export function daysBetween(a, b) {
  const [ay, am, ad] = a.split("-").map(Number);
  const [by, bm, bd] = b.split("-").map(Number);
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86400000);
}

function windowDays(config) {
  const n = Number(config?.filingWindowDays);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

/**
 * Judge a policy at the moment it is identified — before any incident date is
 * known. Only refuses what no incident date could rescue.
 *
 * @param policy { status: 'active'|'cancelled', paymentStatus: 'paid'|'unpaid'|'unknown',
 *                 startDate, endDate }
 * @returns { ok:true, flags:[] } | { ok:false, outcome, ... }
 *   outcomes: cancelled · unpaid · expired · out_of_window · no_dates
 */
export function evaluatePolicyAtValidation(policy, { today, config = {} } = {}) {
  const flags = [];
  if (!policy) return { ok: false, outcome: "not_found" };
  if (policy.status === "cancelled") return { ok: false, outcome: "cancelled" };

  if (policy.paymentStatus === "unpaid") {
    if (config.unpaidPolicies === "refuse") return { ok: false, outcome: "unpaid" };
    flags.push("unpaid_policy");
  }

  const start = toYmd(policy.startDate);
  const end = toYmd(policy.endDate);
  const now = toYmd(today);
  if (!start || !end) return { ok: false, outcome: "no_dates" };

  // Cover not begun: no incident can have happened under it yet — an incident
  // is never in the future.
  if (now < start) return { ok: false, outcome: "not_started", startDate: start };

  if (config.expiryRule === "today") {
    if (now > end) return { ok: false, outcome: "expired", endDate: end };
  } else if (now > end) {
    // incident_date rule: an expired policy may still claim for an incident in
    // cover — unless even the last covered day is outside the filing window.
    const w = windowDays(config);
    if (w !== null && daysBetween(end, now) > w) {
      return { ok: false, outcome: "out_of_window", endDate: end, windowDays: w };
    }
    flags.push("policy_expired_since");
  }
  return { ok: true, flags, startDate: start, endDate: end };
}

/**
 * Judge an incident date against the policy's cover.
 * @returns { ok:true } | { ok:false, reason }
 *   reasons: invalid · future · before_cover · after_cover · out_of_window
 */
export function checkIncidentDate(policy, incidentDate, { today, config = {} } = {}) {
  const d = toYmd(incidentDate);
  const now = toYmd(today);
  if (!d) return { ok: false, reason: "invalid" };
  if (d > now) return { ok: false, reason: "future" };
  const start = toYmd(policy.startDate);
  const end = toYmd(policy.endDate);
  if (start && d < start) return { ok: false, reason: "before_cover", startDate: start, endDate: end };
  if (end && d > end) return { ok: false, reason: "after_cover", startDate: start, endDate: end };
  const w = windowDays(config);
  if (w !== null && daysBetween(d, now) > w) return { ok: false, reason: "out_of_window", windowDays: w };
  return { ok: true };
}

/**
 * Does the plan cover this kind of claim?
 * Unknown on either side (a plan with no structured guarantees, a category
 * mapped to none) is never a refusal and never a flag: we only act on a
 * definite "no".
 *
 * @returns { ok:true, flag:null } | { ok:true, flag:'uncovered_claim_type' } | { ok:false, reason:'uncovered' }
 */
export function checkCoverage(policyGuaranteeCodes, categoryGuaranteeCodes, { config = {} } = {}) {
  const plan = Array.isArray(policyGuaranteeCodes) ? policyGuaranteeCodes.filter(Boolean) : [];
  const needs = Array.isArray(categoryGuaranteeCodes) ? categoryGuaranteeCodes.filter(Boolean) : [];
  if (!plan.length || !needs.length) return { ok: true, flag: null };
  if (needs.some((c) => plan.includes(c))) return { ok: true, flag: null };
  if (config.uncoveredClaimType === "refuse") return { ok: false, reason: "uncovered" };
  return { ok: true, flag: "uncovered_claim_type" };
}

/** The guarantee codes in a catalogue row's pricing_rules, or null if it has none. */
export function guaranteeCodesFromRules(pricingRules) {
  let rules = pricingRules;
  if (typeof rules === "string") {
    try { rules = JSON.parse(rules); } catch { return null; }
  }
  const list = Array.isArray(rules?.guarantees) ? rules.guarantees : [];
  const codes = [...new Set(list.map((g) => g?.coverageType).filter(Boolean))];
  return codes.length ? codes : null;
}

/** Customer-typed policy / card numbers: upper case, no spaces or dots. */
export function normaliseIdentifier(value) {
  return String(value ?? "")
    .toUpperCase()
    .replace(/[\s. ]/g, "")
    .slice(0, 80);
}

/** Does this text look like a separate assistance-card number? Only in "separate" mode. */
export function looksLikeCardNumber(identifier, config = {}) {
  if (config.cardNumberMode !== "separate" || !config.cardNumberPattern) return false;
  try {
    return new RegExp(config.cardNumberPattern).test(identifier);
  } catch {
    return false;
  }
}
