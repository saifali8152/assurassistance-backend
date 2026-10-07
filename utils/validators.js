// src/utils/validators.js
//
// Server-side field validation.
//
// WHY THIS FILE EXISTS: until now every validation rule lived in the React
// forms. That was adequate while the web app was the only way in, but a WhatsApp
// customer types free text straight into the API, so the rules have to live on
// the server. These validators are used by the conversation engine and by the
// public quote endpoints, and they are deliberately independent of any transport.
//
// Every validator returns the same shape:
//   { ok: true, value }                     — normalised value, ready to store
//   { ok: false, code, message, hint? }     — `code` is an i18n key suffix so the
//                                             conversation can answer in FR or EN
//
import { normalizeDateOfBirthForDb, INVALID_DATE_OF_BIRTH_CODE } from "./parseFlexibleDate.js";

const ok = (value) => ({ ok: true, value });
const bad = (code, message, extra = {}) => ({ ok: false, code, message, ...extra });

/* ------------------------------------------------------------------- names */

const NAME_MIN = 2;
const NAME_MAX = 80;
// Letters (any script), spaces, apostrophes, hyphens and dots. No digits.
const NAME_ALLOWED = /^[\p{L}\p{M}][\p{L}\p{M}\s'’.-]*$/u;

export function validateName(input, field = "name") {
  const s = String(input ?? "").trim().replace(/\s+/g, " ");
  if (!s) return bad("required", `${field} is required`);
  if (s.length < NAME_MIN) return bad("name_too_short", `${field} is too short`);
  if (s.length > NAME_MAX) return bad("name_too_long", `${field} is too long`);
  if (/\d/.test(s)) return bad("name_has_digits", `${field} must not contain numbers`);
  if (!NAME_ALLOWED.test(s)) return bad("name_invalid", `${field} contains characters that are not allowed`);
  return ok(s);
}

/* -------------------------------------------------------- passport / ID nr */

export function validatePassportNumber(input) {
  // Uppercase and strip the separators people add by habit.
  const s = String(input ?? "").trim().toUpperCase().replace(/[\s-]/g, "");
  if (!s) return bad("required", "Passport or ID number is required");
  if (s.length < 5) return bad("passport_too_short", "That passport number looks too short");
  if (s.length > 20) return bad("passport_too_long", "That passport number looks too long");
  if (!/^[A-Z0-9]+$/.test(s)) {
    return bad("passport_invalid", "Use letters and numbers only, with no special characters");
  }
  if (!/\d/.test(s)) return bad("passport_no_digit", "A passport number normally contains at least one digit");
  return ok(s);
}

/* ------------------------------------------------------------------- email */

/**
 * Pragmatic RFC-5322-compatible check. Full RFC compliance would accept
 * addresses no mail server in this market will ever route, so the goal here is
 * to catch typos without rejecting anything deliverable.
 */
const EMAIL_RE = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*@(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,}$/;

export function validateEmail(input) {
  const s = String(input ?? "").trim().toLowerCase();
  if (!s) return bad("required", "Email address is required");
  if (s.length > 254) return bad("email_too_long", "That email address is too long");
  if (!EMAIL_RE.test(s)) return bad("email_invalid", "That does not look like a valid email address");
  if (/\.\./.test(s)) return bad("email_invalid", "That does not look like a valid email address");
  return ok(s);
}

/* ------------------------------------------------------------------- phone */

/**
 * Normalise to E.164 (+2250718923194).
 *
 * `defaultCountryCode` is the dialling code to assume when the customer types a
 * local number with no prefix — on WhatsApp we know which country they wrote
 * from, so a bare "0718923194" can be resolved rather than rejected.
 */
export function validatePhoneE164(input, { defaultCountryCode = null } = {}) {
  let s = String(input ?? "").trim();
  if (!s) return bad("required", "Phone number is required");

  const hadPlus = s.startsWith("+") || s.startsWith("00");
  s = s.replace(/^00/, "+");
  s = s.replace(/[\s().\- ]/g, "");

  if (!/^\+?\d+$/.test(s)) return bad("phone_invalid", "Use digits only, optionally starting with +");

  let digits = s.replace(/^\+/, "");

  if (!hadPlus) {
    // A local number: drop a single leading trunk zero and prepend the code.
    if (!defaultCountryCode) {
      return bad("phone_no_country_code", "Please include the country code, for example +225…");
    }
    digits = digits.replace(/^0+/, "");
    digits = `${String(defaultCountryCode).replace(/\D/g, "")}${digits}`;
  }

  // E.164 allows at most 15 digits; nothing routable is shorter than 7.
  if (digits.length < 7) return bad("phone_too_short", "That phone number is too short");
  if (digits.length > 15) return bad("phone_too_long", "That phone number is too long");

  return ok(`+${digits}`);
}

/* ------------------------------------------------------------ date of birth */

const MAX_AGE_YEARS = 120;

/**
 * Accepts every format parseFlexibleDate handles — including French month names
 * — then applies the rules the web form never had to state explicitly: a date of
 * birth cannot be in the future and cannot imply an implausible age.
 */
export function validateDateOfBirth(input, { now = new Date() } = {}) {
  const raw = String(input ?? "").trim();
  if (!raw) return bad("required", "Date of birth is required");

  let normalised;
  try {
    normalised = normalizeDateOfBirthForDb(raw);
  } catch (err) {
    if (err?.code === INVALID_DATE_OF_BIRTH_CODE || err?.message === INVALID_DATE_OF_BIRTH_CODE) {
      return bad("dob_unparseable", "Please write the date as DD/MM/YYYY, for example 12/03/1990");
    }
    return bad("dob_unparseable", "Please write the date as DD/MM/YYYY, for example 12/03/1990");
  }
  if (!normalised) {
    return bad("dob_unparseable", "Please write the date as DD/MM/YYYY, for example 12/03/1990");
  }

  const dob = new Date(`${normalised}T00:00:00Z`);
  if (Number.isNaN(dob.getTime())) {
    return bad("dob_unparseable", "Please write the date as DD/MM/YYYY, for example 12/03/1990");
  }

  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  if (dob.getTime() > today.getTime()) {
    return bad("dob_future", "A date of birth cannot be in the future");
  }

  const age = ageFromDob(normalised, today);
  if (age > MAX_AGE_YEARS) {
    return bad("dob_implausible", "Please check the year of birth");
  }

  return { ok: true, value: normalised, age };
}

/** Whole years between a YYYY-MM-DD string and a reference date. */
export function ageFromDob(ymd, ref = new Date()) {
  const d = new Date(`${String(ymd).slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  let age = ref.getUTCFullYear() - d.getUTCFullYear();
  const m = ref.getUTCMonth() - d.getUTCMonth();
  if (m < 0 || (m === 0 && ref.getUTCDate() < d.getUTCDate())) age -= 1;
  return age;
}

/* ------------------------------------------------------------------ gender */

const GENDER_WORDS = {
  male: "Male", m: "Male", homme: "Male", h: "Male", masculin: "Male", man: "Male",
  female: "Female", f: "Female", femme: "Female", feminin: "Female", "féminin": "Female", woman: "Female",
  other: "Other", autre: "Other", o: "Other",
};

export function validateGender(input) {
  const s = String(input ?? "").trim().toLowerCase();
  if (!s) return bad("required", "Gender is required");
  const mapped = GENDER_WORDS[s];
  if (!mapped) return bad("gender_invalid", "Please choose Male, Female or Other");
  return ok(mapped);
}

/* --------------------------------------------------- grouped personal info */

/**
 * Parse "last name, first name, date of birth" from a single message.
 *
 * Grouping three questions into one is how the flow keeps the message count
 * down, but it only pays off if parsing is reliable. Accepted separators are
 * commas, semicolons, pipes and newlines. Space-only input is accepted
 * ONLY in the unambiguous three-token case, because "Jean Marie Dupont
 * 12/03/1990" cannot be split correctly by guessing.
 *
 * Returns { ok: false, code: 'grouped_ambiguous' } when the flow should fall
 * back to asking one field at a time — never a wrong guess.
 */
export function parseGroupedPersonalInfo(input) {
  const raw = String(input ?? "").trim();
  if (!raw) return bad("required", "Please send your last name, first name and date of birth");

  let parts = raw
    // NOTE: "/" is deliberately NOT a separator — dates are written 12/03/1990,
    // and splitting on it would shred the date into three fields.
    .split(/[,;|\n\r]+/)
    .map((p) => p.trim())
    .filter(Boolean);

  if (parts.length < 3) {
    // Try to lift a date off the end, then split the remainder on whitespace.
    const dateMatch = raw.match(/(\d{1,4}[\s.\-/]\d{1,2}[\s.\-/]\d{1,4}|\d{1,2}\s+\p{L}+\s+\d{2,4})\s*$/u);
    if (dateMatch) {
      const namesPart = raw.slice(0, dateMatch.index).trim();
      const nameTokens = namesPart.split(/\s+/).filter(Boolean);
      if (nameTokens.length === 2) {
        parts = [nameTokens[0], nameTokens[1], dateMatch[1].trim()];
      } else {
        return bad("grouped_ambiguous", "Please send the three details separated by commas");
      }
    } else {
      return bad("grouped_incomplete", "Please send all three: last name, first name and date of birth");
    }
  }

  if (parts.length > 3) {
    // More than three fields: the last one should be the date, the first two the
    // names, and anything in between is almost certainly a middle name.
    parts = [parts[0], parts.slice(1, -1).join(" "), parts[parts.length - 1]];
  }

  const [lastRaw, firstRaw, dobRaw] = parts;

  const last = validateName(lastRaw, "Last name");
  if (!last.ok) return { ...last, field: "last_name" };
  const first = validateName(firstRaw, "First name");
  if (!first.ok) return { ...first, field: "first_name" };
  const dob = validateDateOfBirth(dobRaw);
  if (!dob.ok) return { ...dob, field: "date_of_birth" };

  return {
    ok: true,
    value: { last_name: last.value, first_name: first.value, date_of_birth: dob.value },
    age: dob.age,
  };
}

/* ------------------------------------------------------------- travel dates */

/** Length of stay in whole days, inclusive of both travel days. */
export function daysBetweenInclusive(startYmd, endYmd) {
  const a = new Date(`${String(startYmd).slice(0, 10)}T00:00:00Z`);
  const b = new Date(`${String(endYmd).slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return null;
  return Math.floor((b.getTime() - a.getTime()) / 86400000) + 1;
}

export function validateTravelDates(startInput, endInput, { now = new Date(), maxDays = 365 } = {}) {
  const start = validateDateLoose(startInput);
  if (!start.ok) return { ...start, field: "start_date" };
  const end = validateDateLoose(endInput);
  if (!end.ok) return { ...end, field: "end_date" };

  const days = daysBetweenInclusive(start.value, end.value);
  if (days === null || days < 1) {
    return bad("dates_out_of_order", "The return date must be on or after the departure date");
  }
  if (days > maxDays) {
    return bad("dates_too_long", `Cover is available for up to ${maxDays} days`);
  }

  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  if (new Date(`${start.value}T00:00:00Z`).getTime() < today.getTime()) {
    return bad("start_in_past", "The departure date cannot be in the past");
  }

  return { ok: true, value: { start_date: start.value, end_date: end.value, days } };
}

/** A date that is not a birth date: same parsing, no age rules. */
export function validateDateLoose(input) {
  const raw = String(input ?? "").trim();
  if (!raw) return bad("required", "A date is required");
  try {
    const normalised = normalizeDateOfBirthForDb(raw);
    if (!normalised) return bad("date_unparseable", "Please write the date as DD/MM/YYYY");
    return ok(normalised);
  } catch {
    return bad("date_unparseable", "Please write the date as DD/MM/YYYY");
  }
}

/* ------------------------------------------- grouped identity (4 fields) */

/**
 * Parse "last name, first name, date of birth, passport number".
 *
 * WHY FOUR FIELDS IN ONE MESSAGE: the whole purchase is meant to fit in single
 * figures. Asking these four separately costs four messages on its own. They group safely because the date and the passport number are both
 * self-identifying — a date parses as a date, and a passport number is the
 * alphanumeric token — so a wrong assignment is detectable rather than silent.
 *
 * The passport number is OPTIONAL here: three fields parse fine and the caller
 * then asks for the passport on its own, which is better than rejecting a
 * customer who followed the example loosely.
 */
export function parseGroupedIdentity(input) {
  const raw = String(input ?? "").trim();
  if (!raw) return bad("required", "Please send your last name, first name, date of birth and passport number");

  const parts = raw
    .split(/[,;|\n\r]+/)
    .map((p) => p.trim())
    .filter(Boolean);

  if (parts.length < 3) {
    // Fall back to the three-field parser, which can also split "Ali Saif 12/03/1990".
    const three = parseGroupedPersonalInfo(raw);
    if (!three.ok) return three;
    return { ok: true, value: { ...three.value, passport_or_id: null }, age: three.age, needsPassport: true };
  }

  const last = validateName(parts[0], "Last name");
  if (!last.ok) return { ...last, field: "last_name" };
  const first = validateName(parts[1], "First name");
  if (!first.ok) return { ...first, field: "first_name" };

  // Find the date among the remaining tokens rather than assuming position:
  // customers do send the passport before the date.
  const rest = parts.slice(2);
  let dobIndex = -1;
  let dob = null;
  for (let i = 0; i < rest.length; i += 1) {
    const attempt = validateDateOfBirth(rest[i]);
    if (attempt.ok) {
      dobIndex = i;
      dob = attempt;
      break;
    }
  }
  if (!dob) {
    const reason = validateDateOfBirth(rest[0]);
    return { ...(reason.ok ? bad("dob_unparseable", "Please check the date of birth") : reason), field: "date_of_birth" };
  }

  const remaining = rest.filter((_, i) => i !== dobIndex);
  if (!remaining.length) {
    return {
      ok: true,
      value: { last_name: last.value, first_name: first.value, date_of_birth: dob.value, passport_or_id: null },
      age: dob.age,
      needsPassport: true,
    };
  }

  const passport = validatePassportNumber(remaining.join(""));
  if (!passport.ok) return { ...passport, field: "passport_or_id" };

  return {
    ok: true,
    value: {
      last_name: last.value,
      first_name: first.value,
      date_of_birth: dob.value,
      passport_or_id: passport.value,
    },
    age: dob.age,
    needsPassport: false,
  };
}

/* --------------------------------------- grouped destination + travel dates */

/**
 * Split "France, 01/10/2026, 15/10/2026" into a destination string and the two
 * dates. The destination is returned as raw text for the caller to resolve
 * against the country list — this function deliberately does not know about
 * countries, so it stays testable without a database.
 *
 * Returns { ok: true, value: { destinationText, start_date?, end_date?, days? },
 *           needsDates: boolean }
 */
export function parseDestinationAndDates(input, { now = new Date() } = {}) {
  const raw = String(input ?? "").trim();
  if (!raw) return bad("required", "Please send your destination and travel dates");

  const parts = raw
    .split(/[,;|\n\r]+/)
    .map((p) => p.trim())
    .filter(Boolean);

  if (parts.length === 1) {
    // Maybe "France 01/10/2026 15/10/2026" with spaces only.
    const dates = raw.match(/\d{1,4}[.\-/]\d{1,2}[.\-/]\d{1,4}/g);
    if (dates && dates.length >= 2) {
      const destinationText = raw.slice(0, raw.indexOf(dates[0])).trim();
      if (!destinationText) return bad("destination_missing", "Please include the destination country");
      const range = validateTravelDates(dates[0], dates[1], { now });
      if (!range.ok) return range;
      return { ok: true, value: { destinationText, ...range.value }, needsDates: false };
    }
    return { ok: true, value: { destinationText: parts[0] }, needsDates: true };
  }

  const destinationText = parts[0];
  if (parts.length === 2) {
    // Destination plus a single date is not enough to price a stay.
    return { ok: true, value: { destinationText }, needsDates: true };
  }

  const range = validateTravelDates(parts[1], parts[2], { now });
  if (!range.ok) return range;

  return { ok: true, value: { destinationText, ...range.value }, needsDates: false };
}
