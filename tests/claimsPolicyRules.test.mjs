// tests/claimsPolicyRules.test.mjs
//
// Milestone 4, Day 2 — the policy rules, with every setting the client can
// change. No database.
//
import test from "node:test";
import assert from "node:assert/strict";

import {
  toYmd, daysBetween, evaluatePolicyAtValidation, checkIncidentDate, checkCoverage,
  guaranteeCodesFromRules, normaliseIdentifier, looksLikeCardNumber,
} from "../utils/claims/policyRules.js";
import { identifierHash, passportMatches } from "../models/claimPolicyLookup.js";
import { passportHash } from "../utils/travellerPrivacy.js";

const TODAY = "2026-11-13";
const policy = (over = {}) => ({ status: "active", paymentStatus: "paid", startDate: "2026-11-01", endDate: "2026-11-30", ...over });

/* --------------------------------------------------------------- dates */

test("dates read the same whichever way MySQL or a snapshot spelled them", () => {
  assert.equal(toYmd("2026-11-01"), "2026-11-01");
  assert.equal(toYmd(new Date(2026, 10, 1)), "2026-11-01", "local-midnight Date from mysql2");
  assert.equal(toYmd(new Date(2026, 10, 1).toISOString()), "2026-11-01", "same Date after JSON");
  assert.equal(toYmd(""), null);
  assert.equal(toYmd("not a date"), null);
  assert.equal(daysBetween("2026-10-31", "2026-11-13"), 13);
  assert.equal(daysBetween("2026-12-31", "2027-01-01"), 1);
});

/* ---------------------------------------------- at validation (no date yet) */

test("an active, paid, in-force policy passes with no flags", () => {
  const r = evaluatePolicyAtValidation(policy(), { today: TODAY });
  assert.equal(r.ok, true);
  assert.deepEqual(r.flags, []);
});

test("a cancelled policy never claims — whatever the settings", () => {
  for (const unpaidPolicies of ["allow_flag", "refuse"]) {
    for (const expiryRule of ["incident_date", "today"]) {
      const r = evaluatePolicyAtValidation(policy({ status: "cancelled" }), { today: TODAY, config: { unpaidPolicies, expiryRule } });
      assert.equal(r.outcome, "cancelled");
    }
  }
});

test("unpaid: allowed and flagged by default, refused when the client says so", () => {
  const flagged = evaluatePolicyAtValidation(policy({ paymentStatus: "unpaid" }), { today: TODAY });
  assert.equal(flagged.ok, true);
  assert.deepEqual(flagged.flags, ["unpaid_policy"]);
  const refused = evaluatePolicyAtValidation(policy({ paymentStatus: "unpaid" }), { today: TODAY, config: { unpaidPolicies: "refuse" } });
  assert.equal(refused.outcome, "unpaid");
  assert.equal(evaluatePolicyAtValidation(policy({ paymentStatus: "unknown" }), { today: TODAY, config: { unpaidPolicies: "refuse" } }).ok, true,
    "an imported policy with unknown payment is not treated as unpaid");
});

test("expired, incident-date rule (default): still identified, marked, date checked later", () => {
  const r = evaluatePolicyAtValidation(policy({ startDate: "2026-09-01", endDate: "2026-09-30" }), { today: TODAY });
  assert.equal(r.ok, true);
  assert.deepEqual(r.flags, ["policy_expired_since"]);
});

test("expired, today rule: refused with the end date to explain it", () => {
  const r = evaluatePolicyAtValidation(policy({ startDate: "2026-09-01", endDate: "2026-09-30" }), { today: TODAY, config: { expiryRule: "today" } });
  assert.deepEqual(r, { ok: false, outcome: "expired", endDate: "2026-09-30" });
});

test("filing window: an expired policy whose last day is already too old is refused at once", () => {
  const p = policy({ startDate: "2026-09-01", endDate: "2026-09-30" }); // 44 days ago
  assert.equal(evaluatePolicyAtValidation(p, { today: TODAY, config: { filingWindowDays: 30 } }).outcome, "out_of_window");
  assert.equal(evaluatePolicyAtValidation(p, { today: TODAY, config: { filingWindowDays: 60 } }).ok, true);
  assert.equal(evaluatePolicyAtValidation(p, { today: TODAY, config: { filingWindowDays: "" } }).ok, true, "empty = no limit");
});

test("cover not started yet: nothing can have happened under it", () => {
  const r = evaluatePolicyAtValidation(policy({ startDate: "2026-12-01", endDate: "2026-12-20" }), { today: TODAY });
  assert.equal(r.outcome, "not_started");
});

test("a policy with no dates is not guessed at", () => {
  assert.equal(evaluatePolicyAtValidation(policy({ endDate: null }), { today: TODAY }).outcome, "no_dates");
});

/* ------------------------------------------------------- incident date */

test("the incident must be inside cover, not in the future", () => {
  const p = policy();
  assert.deepEqual(checkIncidentDate(p, "2026-11-05", { today: TODAY }), { ok: true });
  assert.equal(checkIncidentDate(p, "2026-11-01", { today: TODAY }).ok, true, "first day counts");
  assert.equal(checkIncidentDate(p, "2026-11-14", { today: TODAY }).reason, "future");
  assert.equal(checkIncidentDate(p, "2026-10-31", { today: TODAY }).reason, "before_cover");
  assert.equal(checkIncidentDate(p, "garbage", { today: TODAY }).reason, "invalid");
});

test("an expired policy claims for an incident while it was in force, not after", () => {
  const p = policy({ startDate: "2026-09-01", endDate: "2026-09-30" });
  assert.equal(checkIncidentDate(p, "2026-09-30", { today: TODAY }).ok, true, "last day counts");
  const after = checkIncidentDate(p, "2026-10-02", { today: TODAY });
  assert.equal(after.reason, "after_cover");
  assert.equal(after.endDate, "2026-09-30");
});

test("filing window applies to the incident date", () => {
  const p = policy({ startDate: "2026-09-01", endDate: "2026-11-30" });
  assert.equal(checkIncidentDate(p, "2026-10-01", { today: TODAY, config: { filingWindowDays: 30 } }).reason, "out_of_window");
  assert.equal(checkIncidentDate(p, "2026-10-20", { today: TODAY, config: { filingWindowDays: 30 } }).ok, true);
});

/* ------------------------------------------------------------ coverage */

test("coverage: a definite no is flagged by default, refused when set; unknown is never held against anyone", () => {
  assert.deepEqual(checkCoverage(["hospitalization"], ["hospitalization"]), { ok: true, flag: null });
  assert.deepEqual(checkCoverage(["hospitalization"], ["tripCancellation"]), { ok: true, flag: "uncovered_claim_type" });
  assert.deepEqual(checkCoverage(["hospitalization"], ["tripCancellation"], { config: { uncoveredClaimType: "refuse" } }), { ok: false, reason: "uncovered" });
  assert.deepEqual(checkCoverage(null, ["tripCancellation"], { config: { uncoveredClaimType: "refuse" } }), { ok: true, flag: null });
  assert.deepEqual(checkCoverage(["hospitalization"], null, { config: { uncoveredClaimType: "refuse" } }), { ok: true, flag: null });
  assert.deepEqual(checkCoverage(["medicalTransport"], ["evacuationRepatriation", "medicalTransport"]), { ok: true, flag: null }, "any one matching code is enough");
});

test("guarantee codes are read from a plan's pricing rules", () => {
  const rules = { guarantees: [{ coverageType: "hospitalization" }, { coverageType: "bail" }, { coverageType: "bail" }, {}] };
  assert.deepEqual(guaranteeCodesFromRules(rules), ["hospitalization", "bail"]);
  assert.deepEqual(guaranteeCodesFromRules(JSON.stringify(rules)), ["hospitalization", "bail"]);
  assert.equal(guaranteeCodesFromRules(null), null);
  assert.equal(guaranteeCodesFromRules("{broken"), null);
  assert.equal(guaranteeCodesFromRules({ guarantees: [] }), null);
});

/* --------------------------------------------------------- identifiers */

test("typed numbers are read loosely: case, spaces and dots do not matter", () => {
  assert.equal(normaliseIdentifier(" aa-2026 000123. "), "AA-2026000123");
  assert.equal(normaliseIdentifier("aa-2026-000123"), "AA-2026-000123");
});

test("a separate card number is recognised only in separate mode", () => {
  const cfg = { cardNumberMode: "separate", cardNumberPattern: "^CARD[0-9]{6}$" };
  assert.equal(looksLikeCardNumber("CARD123456", cfg), true);
  assert.equal(looksLikeCardNumber("AA-2026-000123", cfg), false);
  assert.equal(looksLikeCardNumber("CARD123456", { ...cfg, cardNumberMode: "certificate" }), false);
  assert.equal(looksLikeCardNumber("CARD123456", { cardNumberMode: "separate" }), false, "no pattern, no card");
});

test("the attempts log never holds what was typed", () => {
  const h = identifierHash("aa-2026-000123");
  assert.match(h, /^[0-9a-f]{64}$/);
  assert.equal(h, identifierHash("AA 2026 000123".replace(/ /g, "-")), "same identifier, same hash");
  assert.ok(!h.includes("2026"));
  assert.equal(identifierHash(""), null);
});

test("passports are compared as keyed hashes, loosely spelled", () => {
  const prev = process.env.SETTINGS_ENCRYPTION_KEY;
  process.env.SETTINGS_ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
  try {
    const row = { passport_or_id_hash: passportHash("AB123456") };
    assert.equal(passportMatches("ab 123 456", row), true);
    assert.equal(passportMatches("AB123457", row), false);
    assert.equal(passportMatches("", row), false);
    assert.equal(passportMatches("AB123456", {}), false, "a row with no passport matches nothing");
    // A legacy row still in plaintext: hashed on the fly, not string-compared.
    assert.equal(passportMatches("ab123456", { passport_or_id: "AB-123456" }), true);
  } finally {
    if (prev === undefined) delete process.env.SETTINGS_ENCRYPTION_KEY; else process.env.SETTINGS_ENCRYPTION_KEY = prev;
  }
});
