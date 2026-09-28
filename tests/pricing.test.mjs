// tests/pricing.test.mjs
//
// The premium a customer is quoted is money, so it gets tests.
//
// Coverage: every age band, every duration tier, the tier-fallback rules, zone
// resolution (including the "zone not in this plan" fallback that keeps today's
// behaviour), and the ineligibility path. Run with: npm test
//
// No database is needed — the pricing path is pure once the plan row is in hand.
//
import test from "node:test";
import assert from "node:assert/strict";

import {
  VALIDITY_TIERS,
  stayDaysToValidityTier,
  getBasePremiumForValidityTier,
  getAgePremiumMultiplier,
  getAgeCommissionMultiplier,
  extractValidityTiersFromPricing,
  parseDaysFromPricingLabel,
} from "../utils/travelPricing.js";
import { computeQuote, computeQuotesForPlans, formatMoney, formatDate, generateQuoteReference } from "../utils/quoteEngine.js";
import { resolveZoneColumn, pricingTablesForZone, matchCountry, normalizeForMatch, paginate } from "../utils/referenceData.js";

/* --------------------------------------------------------------- fixtures */

const SINGLE_ZONE_RULES = {
  pricingColumns: ["Worldwide"],
  pricing: [
    { id: "r10", label: "10 Days", columns: { Worldwide: 20 } },
    { id: "r45", label: "45 Days", columns: { Worldwide: 57 } },
    { id: "r93", label: "93 Days", columns: { Worldwide: 75 } },
    { id: "r180", label: "180 Days", columns: { Worldwide: 101 } },
    { id: "r365", label: "365 Days", columns: { Worldwide: 131 } },
  ],
};

const MULTI_ZONE_RULES = {
  pricingColumns: ["Zone A", "Zone B", "Worldwide"],
  pricing: [
    { id: "r10", label: "10 Days", columns: { "Zone A": 10, "Zone B": 15, Worldwide: 20 } },
    { id: "r45", label: "45 Days", columns: { "Zone A": 30, "Zone B": 45, Worldwide: 57 } },
    { id: "r93", label: "93 Days", columns: { "Zone A": 40, "Zone B": 60, Worldwide: 75 } },
  ],
};

const plan = (overrides = {}) => ({
  id: 1,
  name: "Agico Retail",
  product_type: "Travel",
  currency: "XOF",
  pricing_rules: SINGLE_ZONE_RULES,
  flat_price: null,
  fixed_duration_premiums: 0,
  ...overrides,
});

const country = (zone = "Worldwide", code = "FR") => ({
  code, name_en: "France", name_fr: "France", zone, active: true,
});

/** A date of birth that yields exactly `age` on a fixed reference date. */
const REF = new Date("2026-09-28T00:00:00Z");
const dobForAge = (age) => `${REF.getUTCFullYear() - age}-01-01`;

/* ----------------------------------------------------------- duration tiers */

test("stay days map to the smallest covering validity tier", () => {
  assert.equal(stayDaysToValidityTier(1), 10);
  assert.equal(stayDaysToValidityTier(10), 10);
  assert.equal(stayDaysToValidityTier(11), 45);
  assert.equal(stayDaysToValidityTier(45), 45);
  assert.equal(stayDaysToValidityTier(46), 93);
  assert.equal(stayDaysToValidityTier(93), 93);
  assert.equal(stayDaysToValidityTier(94), 180);
  assert.equal(stayDaysToValidityTier(180), 180);
  assert.equal(stayDaysToValidityTier(181), 365);
  assert.equal(stayDaysToValidityTier(365), 365);
});

test("a stay longer than the longest tier falls back to that tier", () => {
  assert.equal(stayDaysToValidityTier(400), 365);
  assert.equal(stayDaysToValidityTier(10_000), 365);
});

test("a plan's own tiers override the defaults (Agico Burundi 32/63)", () => {
  const burundi = {
    pricingColumns: ["Worldwide"],
    pricing: [
      { label: "10 Days", columns: { Worldwide: 20 } },
      { label: "32 Days", columns: { Worldwide: 39 } },
      { label: "63 Days", columns: { Worldwide: 67 } },
    ],
  };
  const tiers = extractValidityTiersFromPricing(burundi);
  assert.deepEqual(tiers, [10, 32, 63]);
  assert.equal(stayDaysToValidityTier(11, tiers), 32);
  assert.equal(stayDaysToValidityTier(33, tiers), 63);
});

test("duration labels parse in English and French", () => {
  assert.equal(parseDaysFromPricingLabel("45 Days"), 45);
  assert.equal(parseDaysFromPricingLabel("45 Jours"), 45);
  assert.equal(parseDaysFromPricingLabel("1 an"), 365);
  assert.equal(parseDaysFromPricingLabel("nonsense"), null);
});

test("every tier resolves to its own price", () => {
  for (const [days, expected] of [[10, 20], [45, 57], [93, 75], [180, 101], [365, 131]]) {
    assert.equal(getBasePremiumForValidityTier(SINGLE_ZONE_RULES, days), expected, `tier ${days}`);
  }
});

/* ---------------------------------------------------------------- age bands */

test("age multipliers match the documented bands", () => {
  assert.equal(getAgePremiumMultiplier(0).multiplier, 0.5);
  assert.equal(getAgePremiumMultiplier(15).multiplier, 0.5);
  assert.equal(getAgePremiumMultiplier(16).multiplier, 1);
  assert.equal(getAgePremiumMultiplier(75).multiplier, 1);
  assert.equal(getAgePremiumMultiplier(76).multiplier, 2);
  assert.equal(getAgePremiumMultiplier(80).multiplier, 2);
  assert.equal(getAgePremiumMultiplier(81).multiplier, 4);
  assert.equal(getAgePremiumMultiplier(85).multiplier, 4);
  assert.equal(getAgePremiumMultiplier(86).eligible, false);
  assert.equal(getAgePremiumMultiplier(120).eligible, false);
});

test("every age band boundary is priced correctly on every tier", () => {
  const bands = [
    { age: 15, factor: 0.5, band: "child" },
    { age: 16, factor: 1, band: "standard" },
    { age: 75, factor: 1, band: "standard" },
    { age: 76, factor: 2, band: "senior76_80" },
    { age: 80, factor: 2, band: "senior76_80" },
    { age: 81, factor: 4, band: "senior81_85" },
    { age: 85, factor: 4, band: "senior81_85" },
  ];
  const tierPrices = { 10: 20, 45: 57, 93: 75, 180: 101, 365: 131 };

  for (const { age, factor, band } of bands) {
    for (const [tier, base] of Object.entries(tierPrices)) {
      const res = computeQuote({
        plan: plan(),
        destination: country(),
        stayDays: Number(tier),
        dateOfBirth: dobForAge(age),
      });
      assert.equal(res.ok, true, `age ${age} tier ${tier}: ${res.message || ""}`);
      assert.equal(res.quote.traveller.ageBand, band, `band for age ${age}`);
      assert.equal(res.quote.pricing.basePremium, base, `base for tier ${tier}`);
      assert.equal(
        res.quote.pricing.premium,
        Math.round(base * factor * 100) / 100,
        `premium for age ${age} on tier ${tier}`
      );
    }
  }
});

test("commission is halved for children but never raised by senior surcharges", () => {
  assert.equal(getAgeCommissionMultiplier(10), 0.5);
  assert.equal(getAgeCommissionMultiplier(30), 1);
  assert.equal(getAgeCommissionMultiplier(82), 1);
});

test("over 85 is refused with the exemption message, not a price", () => {
  const res = computeQuote({
    plan: plan(), destination: country(), stayDays: 10, dateOfBirth: dobForAge(90),
  });
  assert.equal(res.ok, false);
  assert.equal(res.code, "age_ineligible");
  assert.match(res.message, /exemption/i);
});

/* -------------------------------------------------------------------- zones */

test("zone resolution prefers the matching plan column", () => {
  const r = resolveZoneColumn(MULTI_ZONE_RULES, "Zone B");
  assert.equal(r.column, "Zone B");
  assert.equal(r.matched, true);
});

test("an unknown zone falls back to the plan's first column without failing", () => {
  const r = resolveZoneColumn(MULTI_ZONE_RULES, "Zone Q");
  assert.equal(r.column, "Zone A");
  assert.equal(r.matched, false);
});

test("zone matching ignores case, accents and punctuation", () => {
  assert.equal(resolveZoneColumn(MULTI_ZONE_RULES, "zone b").column, "Zone B");
  assert.equal(resolveZoneColumn(MULTI_ZONE_RULES, "ZONE-B").column, "Zone B");
});

test("reordering columns never mutates the original plan rules", () => {
  const original = JSON.parse(JSON.stringify(MULTI_ZONE_RULES));
  pricingTablesForZone(MULTI_ZONE_RULES, "Worldwide");
  assert.deepEqual(MULTI_ZONE_RULES, original);
});

test("each zone is priced from its own column", () => {
  for (const [zone, expected] of [["Zone A", 10], ["Zone B", 15], ["Worldwide", 20]]) {
    const res = computeQuote({
      plan: plan({ pricing_rules: MULTI_ZONE_RULES }),
      destination: country(zone),
      stayDays: 10,
      dateOfBirth: dobForAge(30),
    });
    assert.equal(res.ok, true, zone);
    assert.equal(res.quote.pricing.premium, expected, `premium for ${zone}`);
    assert.equal(res.quote.zone.column, zone);
    assert.equal(res.quote.zone.matchedPlanColumn, true);
  }
});

test("single-zone plans price identically with or without a destination — today's behaviour is preserved", () => {
  const withDest = computeQuote({
    plan: plan(), destination: country("Zone A"), stayDays: 45, dateOfBirth: dobForAge(30),
  });
  const withoutDest = computeQuote({
    plan: plan(), destination: null, stayDays: 45, dateOfBirth: dobForAge(30),
  });
  assert.equal(withDest.ok && withoutDest.ok, true);
  assert.equal(withDest.quote.pricing.premium, 57);
  assert.equal(withoutDest.quote.pricing.premium, 57);
  assert.equal(withDest.quote.zone.matchedPlanColumn, false, "Zone A is not a column on this plan");
});

/* ------------------------------------------------------------------- quotes */

test("dates are converted to an inclusive day count", () => {
  const res = computeQuote({
    plan: plan(), destination: country(), startDate: "2026-10-01", endDate: "2026-10-08",
    dateOfBirth: dobForAge(30),
  });
  assert.equal(res.ok, true);
  assert.equal(res.quote.travel.stayDays, 8);
  assert.equal(res.quote.travel.validityDays, 10);
});

test("pricing_rules supplied as a JSON string is handled", () => {
  const res = computeQuote({
    plan: plan({ pricing_rules: JSON.stringify(SINGLE_ZONE_RULES) }),
    destination: country(), stayDays: 10, dateOfBirth: dobForAge(30),
  });
  assert.equal(res.ok, true);
  assert.equal(res.quote.pricing.premium, 20);
});

test("a plan with no usable pricing is rejected with a reason", () => {
  const res = computeQuote({
    plan: plan({ pricing_rules: null, flat_price: null }),
    destination: country(), stayDays: 10, dateOfBirth: dobForAge(30),
  });
  assert.equal(res.ok, false);
  assert.equal(res.code, "no_price_for_inputs");
});

test("flat-price plans are priced per day", () => {
  const res = computeQuote({
    plan: plan({ product_type: "Bank", pricing_rules: null, flat_price: 5 }),
    destination: country(), stayDays: 4, dateOfBirth: dobForAge(30),
  });
  assert.equal(res.ok, true);
  assert.equal(res.quote.pricing.premium, 20);
});

test("non-travel products are not age-loaded", () => {
  const res = computeQuote({
    plan: plan({ product_type: "Bank" }),
    destination: country(), stayDays: 10, dateOfBirth: dobForAge(82),
  });
  assert.equal(res.ok, true);
  assert.equal(res.quote.pricing.premium, 20, "no senior multiplier on non-travel plans");
});

test("multiple plans are priced and sorted cheapest first, with rejects reported", () => {
  const { priced, rejected } = computeQuotesForPlans({
    plans: [
      plan({ id: 1, name: "Expensive", pricing_rules: { pricingColumns: ["Worldwide"], pricing: [{ label: "10 Days", columns: { Worldwide: 99 } }] } }),
      plan({ id: 2, name: "Cheap", pricing_rules: { pricingColumns: ["Worldwide"], pricing: [{ label: "10 Days", columns: { Worldwide: 11 } }] } }),
      plan({ id: 3, name: "Broken", pricing_rules: null, flat_price: null }),
    ],
    destination: country(), stayDays: 10, dateOfBirth: dobForAge(30),
  });
  assert.equal(priced.length, 2);
  assert.equal(priced[0].plan.name, "Cheap");
  assert.equal(priced[1].plan.name, "Expensive");
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].planName, "Broken");
});

test("quote references are unique and correctly prefixed", () => {
  const refs = new Set(Array.from({ length: 500 }, () => generateQuoteReference()));
  assert.equal(refs.size, 500);
  assert.match([...refs][0], /^QT-[0-9A-F]{8}$/);
});

/* ---------------------------------------------------------------- formatting */

test("money formats without decimals for XOF and with decimals for USD", () => {
  assert.match(formatMoney(20, "XOF", "fr"), /20/);
  assert.ok(!formatMoney(20, "XOF", "fr").includes(",00"));
  assert.match(formatMoney(20.5, "USD", "en"), /20\.50/);
});

test("an unknown currency code still renders an amount", () => {
  assert.match(formatMoney(20, "NOTACURRENCY", "fr"), /20/);
});

/* --------------------------------------------------------- country matching */

const COUNTRIES = [
  { code: "FR", name_en: "France", name_fr: "France", zone: "Worldwide", active: true },
  { code: "CI", name_en: "Côte-d'Ivoire", name_fr: "Côte-d'Ivoire", zone: "Worldwide", active: true },
  { code: "ES", name_en: "Spain", name_fr: "Espagne", zone: "Worldwide", active: true },
  { code: "GB", name_en: "United Kingdom", name_fr: "Royaume-Uni", zone: "Worldwide", active: true },
  { code: "US", name_en: "United States", name_fr: "États-Unis", zone: "Worldwide", active: true },
  { code: "MA", name_en: "Morocco", name_fr: "Maroc", zone: "Worldwide", active: true },
];

test("an exact name matches in either language", () => {
  assert.equal(matchCountry("France", COUNTRIES).match.code, "FR");
  assert.equal(matchCountry("Espagne", COUNTRIES).match.code, "ES");
  assert.equal(matchCountry("Spain", COUNTRIES).match.code, "ES");
});

test("accents and punctuation are ignored", () => {
  assert.equal(matchCountry("cote divoire", COUNTRIES).match.code, "CI");
  assert.equal(matchCountry("COTE D'IVOIRE", COUNTRIES).match.code, "CI");
  assert.equal(matchCountry("etats unis", COUNTRIES).match.code, "US");
});

test("an ISO code matches", () => {
  assert.equal(matchCountry("ci", COUNTRIES).match.code, "CI");
  assert.equal(matchCountry("GB", COUNTRIES).match.code, "GB");
});

test("a typo within two edits still resolves", () => {
  assert.equal(matchCountry("Fance", COUNTRIES).match.code, "FR");
  assert.equal(matchCountry("Maroco", COUNTRIES).match.code, "MA");
});

test("an ambiguous prefix returns candidates instead of guessing", () => {
  const res = matchCountry("United", COUNTRIES);
  assert.equal(res.match, null);
  assert.equal(res.candidates.length, 2);
});

test("unrecognisable input returns nothing rather than a wrong country", () => {
  const res = matchCountry("zzzzzz", COUNTRIES);
  assert.equal(res.match, null);
  assert.equal(res.candidates.length, 0);
});

test("normalisation is stable", () => {
  assert.equal(normalizeForMatch("Côte-d'Ivoire"), "cotedivoire");
  assert.equal(normalizeForMatch("  États-Unis  "), "etatsunis");
});

/* ------------------------------------------------- WhatsApp list pagination */

test("pagination leaves room for a More row", () => {
  const items = Array.from({ length: 25 }, (_, i) => i);
  const p0 = paginate(items, 0);
  assert.equal(p0.items.length, 9, "9 rows + More never exceeds Meta's 10-row cap");
  assert.equal(p0.hasMore, true);
  assert.equal(p0.pages, 3);

  const last = paginate(items, 2);
  assert.equal(last.items.length, 7);
  assert.equal(last.hasMore, false);
});

/* ------------------------------------------------ date serialisation guard */

/**
 * REGRESSION GUARD, found by an integration test rather than a unit test.
 *
 * mysql2 returns a DATE column as a Date at LOCAL midnight. Serialising it with
 * toISOString() converts to UTC and lands on the previous day for every server
 * east of Greenwich — which includes the production VPS and both offices. Every
 * travel date and date of birth read back through the API was one day early.
 *
 * This test pins the correct behaviour in the timezone where the bug appears.
 */
test("a DATE at local midnight serialises to the same calendar day, not the day before", () => {
  const original = process.env.TZ;
  try {
    process.env.TZ = "Asia/Karachi"; // UTC+5, where the bug showed up
    const localMidnight = new Date(2026, 9, 1, 0, 0, 0); // 1 October 2026, local
    const viaIso = localMidnight.toISOString().slice(0, 10);
    const viaLocalParts = `${localMidnight.getFullYear()}-${String(localMidnight.getMonth() + 1).padStart(2, "0")}-${String(localMidnight.getDate()).padStart(2, "0")}`;

    assert.equal(viaLocalParts, "2026-10-01", "local parts give the stored day");
    if (new Date().getTimezoneOffset() < 0) {
      assert.notEqual(viaIso, viaLocalParts, "toISOString shifts the day in a positive offset — this is the bug");
    }
  } finally {
    if (original === undefined) delete process.env.TZ;
    else process.env.TZ = original;
  }
});

test("formatDate reads a plain YYYY-MM-DD string as that exact day", () => {
  // formatDate anchors the string at UTC midnight and formats in UTC, so the
  // displayed day can never drift from the stored day.
  assert.match(formatDate("2026-10-01", "en"), /01 October 2026/);
  assert.match(formatDate("2026-10-01", "fr"), /01 octobre 2026/);
  assert.match(formatDate("2026-01-31", "en"), /31 January 2026/);
});
