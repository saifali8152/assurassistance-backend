// tests/validators.test.mjs
//
// A WhatsApp customer types free text, so these validators are the only thing
// standing between a typo and a policy issued to the wrong person.
//
import test from "node:test";
import assert from "node:assert/strict";

import {
  validateName,
  validatePassportNumber,
  validateEmail,
  validatePhoneE164,
  validateDateOfBirth,
  validateGender,
  parseGroupedPersonalInfo,
  validateTravelDates,
  daysBetweenInclusive,
  ageFromDob,
} from "../utils/validators.js";

const NOW = new Date("2026-09-28T00:00:00Z");

/* -------------------------------------------------------------------- names */

test("ordinary names are accepted and whitespace normalised", () => {
  assert.equal(validateName("Saif").value, "Saif");
  assert.equal(validateName("  Jean   Marie  ").value, "Jean Marie");
});

test("names with accents, apostrophes and hyphens are accepted", () => {
  for (const n of ["Kouassi", "N'Guessan", "Jean-Pierre", "Müller", "Traoré", "O'Brien"]) {
    assert.equal(validateName(n).ok, true, n);
  }
});

test("names with digits or symbols are rejected", () => {
  assert.equal(validateName("Saif123").ok, false);
  assert.equal(validateName("Saif123").code, "name_has_digits");
  assert.equal(validateName("<script>").ok, false);
  assert.equal(validateName("!!!").ok, false);
});

test("empty and over-long names are rejected", () => {
  assert.equal(validateName("").code, "required");
  assert.equal(validateName("A").code, "name_too_short");
  assert.equal(validateName("A".repeat(81)).code, "name_too_long");
});

/* ----------------------------------------------------------------- passport */

test("passport numbers are uppercased and separators stripped", () => {
  assert.equal(validatePassportNumber("ab 123-4567").value, "AB1234567");
});

test("passport numbers need a digit and no symbols", () => {
  assert.equal(validatePassportNumber("ABCDEFGH").code, "passport_no_digit");
  assert.equal(validatePassportNumber("AB#1234").code, "passport_invalid");
  assert.equal(validatePassportNumber("AB12").code, "passport_too_short");
  assert.equal(validatePassportNumber("A".repeat(19) + "1").ok, true, "20 characters is still valid");
  assert.equal(validatePassportNumber("A".repeat(20) + "1").code, "passport_too_long");
});

/* -------------------------------------------------------------------- email */

test("valid addresses are accepted and lowercased", () => {
  assert.equal(validateEmail("Info@Devzz.Tech").value, "info@devzz.tech");
  assert.equal(validateEmail("first.last+tag@sub.example.co.uk").ok, true);
});

test("malformed addresses are rejected", () => {
  for (const e of ["plainword", "no@domain", "@example.com", "a@b", "two..dots@example.com", "spa ce@example.com"]) {
    assert.equal(validateEmail(e).ok, false, e);
  }
});

/* -------------------------------------------------------------------- phone */

test("international numbers normalise to E.164", () => {
  assert.equal(validatePhoneE164("+225 07 18 92 31 94").value, "+2250718923194");
  assert.equal(validatePhoneE164("00225 0718923194").value, "+2250718923194");
  assert.equal(validatePhoneE164("+92 (300) 123-4567").value, "+923001234567");
});

test("a local number resolves when the country code is known", () => {
  assert.equal(validatePhoneE164("0718923194", { defaultCountryCode: "225" }).value, "+225718923194");
});

test("a local number without a country code is refused rather than guessed", () => {
  assert.equal(validatePhoneE164("0718923194").code, "phone_no_country_code");
});

test("impossible lengths and non-digits are rejected", () => {
  assert.equal(validatePhoneE164("+22 5").code, "phone_too_short");
  assert.equal(validatePhoneE164("+" + "9".repeat(16)).code, "phone_too_long");
  assert.equal(validatePhoneE164("+225abc").code, "phone_invalid");
});

/* ------------------------------------------------------------ date of birth */

test("every documented date format is accepted", () => {
  for (const d of ["12/03/1990", "12-03-1990", "12.03.1990", "1990-03-12"]) {
    const r = validateDateOfBirth(d, { now: NOW });
    assert.equal(r.ok, true, d);
    assert.equal(r.value, "1990-03-12", d);
  }
});

test("French month names are accepted — the same parser the web app uses", () => {
  const r = validateDateOfBirth("12 mars 1990", { now: NOW });
  assert.equal(r.ok, true);
  assert.equal(r.value, "1990-03-12");
});

test("a future date of birth is rejected", () => {
  assert.equal(validateDateOfBirth("01/01/2030", { now: NOW }).code, "dob_future");
});

test("an implausible age is rejected", () => {
  assert.equal(validateDateOfBirth("01/01/1850", { now: NOW }).code, "dob_implausible");
});

test("unparseable input is rejected with guidance", () => {
  assert.equal(validateDateOfBirth("sometime in the nineties", { now: NOW }).code, "dob_unparseable");
  assert.equal(validateDateOfBirth("99/99/9999", { now: NOW }).ok, false);
});

test("age is computed on whole years, including the birthday edge", () => {
  assert.equal(ageFromDob("1990-03-12", NOW), 36);
  assert.equal(ageFromDob("2026-09-28", NOW), 0);
  assert.equal(ageFromDob("2026-09-29", NOW), -1, "tomorrow's birthday is not yet reached");
});

/* ------------------------------------------------------------------- gender */

test("gender is accepted in French and English, long and short", () => {
  for (const [input, expected] of [
    ["male", "Male"], ["M", "Male"], ["homme", "Male"], ["H", "Male"],
    ["female", "Female"], ["F", "Female"], ["femme", "Female"],
    ["other", "Other"], ["autre", "Other"],
  ]) {
    assert.equal(validateGender(input).value, expected, input);
  }
});

test("unknown gender input is rejected", () => {
  assert.equal(validateGender("banana").code, "gender_invalid");
});

/* --------------------------------------------------- grouped personal info */

test("comma-separated grouped input is parsed", () => {
  const r = parseGroupedPersonalInfo("Ali, Saif, 12/03/1990");
  assert.equal(r.ok, true);
  assert.deepEqual(r.value, { last_name: "Ali", first_name: "Saif", date_of_birth: "1990-03-12" });
});

test("other separators work too", () => {
  for (const s of ["Ali; Saif; 12/03/1990", "Ali | Saif | 12-03-1990", "Ali\nSaif\n12.03.1990"]) {
    assert.equal(parseGroupedPersonalInfo(s).ok, true, s);
  }
});

test("two names plus a trailing date parse without separators", () => {
  const r = parseGroupedPersonalInfo("Ali Saif 12/03/1990");
  assert.equal(r.ok, true);
  assert.equal(r.value.last_name, "Ali");
  assert.equal(r.value.first_name, "Saif");
});

test("a middle name is folded into the first name rather than lost", () => {
  const r = parseGroupedPersonalInfo("Traoré, Jean, Marie, 12/03/1990");
  assert.equal(r.ok, true);
  assert.equal(r.value.last_name, "Traoré");
  assert.equal(r.value.first_name, "Jean Marie");
});

test("ambiguous input asks for separators instead of guessing", () => {
  const r = parseGroupedPersonalInfo("Jean Marie Dupont 12/03/1990");
  assert.equal(r.ok, false);
  assert.equal(r.code, "grouped_ambiguous");
});

test("incomplete grouped input is reported as incomplete", () => {
  assert.equal(parseGroupedPersonalInfo("Ali, Saif").code, "grouped_incomplete");
  assert.equal(parseGroupedPersonalInfo("").code, "required");
});

test("a bad field inside grouped input is named, so only that field is re-asked", () => {
  const r = parseGroupedPersonalInfo("Ali, Saif, notadate");
  assert.equal(r.ok, false);
  assert.equal(r.field, "date_of_birth");

  const r2 = parseGroupedPersonalInfo("Ali9, Saif, 12/03/1990");
  assert.equal(r2.field, "last_name");
});

/* ------------------------------------------------------------- travel dates */

test("inclusive day counts are correct", () => {
  assert.equal(daysBetweenInclusive("2026-10-01", "2026-10-01"), 1);
  assert.equal(daysBetweenInclusive("2026-10-01", "2026-10-08"), 8);
  assert.equal(daysBetweenInclusive("2026-12-31", "2027-01-01"), 2);
});

test("valid travel dates pass with a day count", () => {
  const r = validateTravelDates("01/10/2026", "08/10/2026", { now: NOW });
  assert.equal(r.ok, true);
  assert.equal(r.value.days, 8);
});

test("reversed, past and over-long date ranges are rejected", () => {
  assert.equal(validateTravelDates("08/10/2026", "01/10/2026", { now: NOW }).code, "dates_out_of_order");
  assert.equal(validateTravelDates("01/01/2020", "08/01/2020", { now: NOW }).code, "start_in_past");
  assert.equal(validateTravelDates("01/10/2026", "01/10/2028", { now: NOW }).code, "dates_too_long");
});

test("travelling today is allowed", () => {
  assert.equal(validateTravelDates("28/09/2026", "05/10/2026", { now: NOW }).ok, true);
});

/* ------------------------------------------------- grouped identity (4 up) */

import { parseGroupedIdentity, parseDestinationAndDates } from "../utils/validators.js";

test("four-field identity parses in one message", () => {
  const r = parseGroupedIdentity("Ali, Saif, 12/03/1990, AB1234567");
  assert.equal(r.ok, true);
  assert.deepEqual(r.value, {
    last_name: "Ali", first_name: "Saif", date_of_birth: "1990-03-12", passport_or_id: "AB1234567",
  });
  assert.equal(r.needsPassport, false);
});

test("passport before the date is still assigned correctly", () => {
  const r = parseGroupedIdentity("Ali, Saif, AB1234567, 12/03/1990");
  assert.equal(r.ok, true);
  assert.equal(r.value.passport_or_id, "AB1234567");
  assert.equal(r.value.date_of_birth, "1990-03-12");
});

test("three fields are accepted and the passport is asked for separately", () => {
  const r = parseGroupedIdentity("Ali, Saif, 12/03/1990");
  assert.equal(r.ok, true);
  assert.equal(r.value.passport_or_id, null);
  assert.equal(r.needsPassport, true);
});

test("a bad field in the identity group is named so only it is re-asked", () => {
  assert.equal(parseGroupedIdentity("Ali9, Saif, 12/03/1990, AB1234567").field, "last_name");
  assert.equal(parseGroupedIdentity("Ali, Saif, notadate, AB1234567").field, "date_of_birth");
  assert.equal(parseGroupedIdentity("Ali, Saif, 12/03/1990, AB#!").field, "passport_or_id");
});

/* ------------------------------------------- destination + dates in one go */

test("destination and both dates parse from one message", () => {
  const r = parseDestinationAndDates("France, 01/10/2026, 15/10/2026", { now: NOW });
  assert.equal(r.ok, true);
  assert.equal(r.value.destinationText, "France");
  assert.equal(r.value.start_date, "2026-10-01");
  assert.equal(r.value.end_date, "2026-10-15");
  assert.equal(r.value.days, 15);
  assert.equal(r.needsDates, false);
});

test("space-separated destination and dates also parse", () => {
  const r = parseDestinationAndDates("Cote d'Ivoire 01/10/2026 15/10/2026", { now: NOW });
  assert.equal(r.ok, true);
  assert.equal(r.value.destinationText, "Cote d'Ivoire");
  assert.equal(r.value.days, 15);
});

test("a destination alone asks for the dates next", () => {
  const r = parseDestinationAndDates("France", { now: NOW });
  assert.equal(r.ok, true);
  assert.equal(r.value.destinationText, "France");
  assert.equal(r.needsDates, true);
});

test("a destination with one date is treated as needing dates", () => {
  const r = parseDestinationAndDates("France, 01/10/2026", { now: NOW });
  assert.equal(r.ok, true);
  assert.equal(r.needsDates, true);
});

test("invalid date ranges inside the group are reported, not swallowed", () => {
  assert.equal(parseDestinationAndDates("France, 15/10/2026, 01/10/2026", { now: NOW }).code, "dates_out_of_order");
  assert.equal(parseDestinationAndDates("France, 01/01/2020, 08/01/2020", { now: NOW }).code, "start_in_past");
});
