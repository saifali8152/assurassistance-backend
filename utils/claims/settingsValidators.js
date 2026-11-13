// src/utils/claims/settingsValidators.js
//
// Validators for the claims settings. Each returns { ok, message } and never
// throws, matching the contract of validateSettingValue in settingsModel.js.

const EMAIL = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]{2,}$/;

/** "a@x.com, b@y.org" — up to 10 addresses, each a plausible email. */
export function validateEmailList(value) {
  const parts = String(value || "").split(/[,;\s]+/).map((s) => s.trim()).filter(Boolean);
  if (!parts.length) return { ok: true };
  if (parts.length > 10) return { ok: false, message: "at most 10 addresses" };
  const bad = parts.filter((p) => !EMAIL.test(p));
  if (bad.length) return { ok: false, message: `not a valid email: ${bad.join(", ")}` };
  return { ok: true };
}

export function parseEmailList(value) {
  return String(value || "").split(/[,;\s]+/).map((s) => s.trim()).filter((p) => EMAIL.test(p));
}

/**
 * A regular expression for the separate assistance card number.
 *
 * Bounded in length, and refused when it has nested quantifiers like (a+)+ —
 * the pattern is evaluated against customer input, and a catastrophic
 * backtracking pattern would let one message pin the CPU.
 */
export function validatePattern(value) {
  const s = String(value || "");
  if (!s) return { ok: true };
  if (s.length > 200) return { ok: false, message: "pattern is too long (200 characters max)" };
  if (/\([^)]*[+*][^)]*\)\s*[+*{]/.test(s)) {
    return { ok: false, message: "nested repetition like (a+)+ is not allowed" };
  }
  try {
    new RegExp(s);
  } catch (err) {
    return { ok: false, message: `invalid pattern: ${err.message}` };
  }
  return { ok: true };
}

/** Comma-separated keyword list. */
export function validateKeywordList(value) {
  const parts = String(value || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (parts.length > 100) return { ok: false, message: "at most 100 keywords" };
  if (parts.some((p) => p.length > 60)) return { ok: false, message: "a keyword is longer than 60 characters" };
  return { ok: true };
}

export function parseKeywordList(value) {
  return String(value || "").split(",").map((s) => s.trim()).filter(Boolean);
}
