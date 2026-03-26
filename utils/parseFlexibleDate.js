/**
 * Normalize user/Excel-provided dates to MySQL DATE strings (YYYY-MM-DD).
 * Handles ISO, DMY/MDY slashes, Excel serials, and many locale strings (Date.parse).
 */

export const INVALID_DATE_OF_BIRTH_CODE = "INVALID_DATE_OF_BIRTH";

function pad2(n) {
  return String(n).padStart(2, "0");
}

function isValidYMD(y, m, d) {
  if (y < 1000 || y > 9999 || m < 1 || m > 12 || d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/** Excel serial date → YYYY-MM-DD (UTC, Lotus 1900 epoch) */
function fromExcelSerial(serial) {
  if (!Number.isFinite(serial)) return null;
  // Reasonable DOB range in Excel serial (~ 1900–2100)
  if (serial < 200 || serial > 100000) return null;
  const ms = (serial - 25569) * 86400 * 1000;
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return null;
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + 1;
  const day = d.getUTCDate();
  if (!isValidYMD(y, m, day)) return null;
  return `${y}-${pad2(m)}-${pad2(day)}`;
}

/** Replace common French month names (and short forms) so Date.parse can read the string */
function frenchMonthsToEnglish(s) {
  const abbrevs = [
    [/\bjanv\.?\b/gi, "January"],
    [/\bfévr?\.?\b|\bfevr\.?\b/gi, "February"],
    [/\bmars\b/gi, "March"],
    [/\bavr\.?\b/gi, "April"],
    [/\bmai\b/gi, "May"],
    [/\bjuin\b/gi, "June"],
    [/\bjuil\.?\b/gi, "July"],
    [/\baoût\b|\baout\b/gi, "August"],
    [/\bsept\.?\b/gi, "September"],
    [/\boct\.?\b/gi, "October"],
    [/\bnov\.?\b/gi, "November"],
    [/\bdéc\.?\b|\bdec\.?\b/gi, "December"]
  ];
  const full = [
    [/janvier/gi, "January"],
    [/février|fevrier/gi, "February"],
    [/mars/gi, "March"],
    [/avril/gi, "April"],
    [/mai/gi, "May"],
    [/juin/gi, "June"],
    [/juillet/gi, "July"],
    [/août|aout/gi, "August"],
    [/septembre/gi, "September"],
    [/octobre/gi, "October"],
    [/novembre/gi, "November"],
    [/décembre|decembre/gi, "December"]
  ];
  let out = s;
  for (const [re, en] of abbrevs) out = out.replace(re, en);
  for (const [re, en] of full) out = out.replace(re, en);
  return out;
}

/**
 * @param {string|number|null|undefined} input
 * @returns {string|null} YYYY-MM-DD or null if empty/unparseable
 */
export function parseFlexibleDateToMySQL(input) {
  if (input == null) return null;
  if (typeof input === "number" && Number.isFinite(input)) {
    if (Number.isInteger(input) || input === Math.floor(input)) {
      const fromEx = fromExcelSerial(input);
      if (fromEx) return fromEx;
    }
    return null;
  }

  const s0 = String(input).trim();
  if (!s0) return null;

  const iso = s0.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T\s].*)?$/);
  if (iso) {
    const y = parseInt(iso[1], 10);
    const m = parseInt(iso[2], 10);
    const d = parseInt(iso[3], 10);
    if (isValidYMD(y, m, d)) return `${y}-${pad2(m)}-${pad2(d)}`;
  }

  const slash = s0.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})$/);
  if (slash) {
    let a = parseInt(slash[1], 10);
    let b = parseInt(slash[2], 10);
    let y = parseInt(slash[3], 10);
    if (y < 100) y += y >= 70 ? 1900 : 2000;
    let day;
    let month;
    if (a > 12) {
      day = a;
      month = b;
    } else if (b > 12) {
      month = a;
      day = b;
    } else {
      // Ambiguous: prefer DMY (common for Excel outside US)
      day = a;
      month = b;
    }
    if (isValidYMD(y, month, day)) return `${y}-${pad2(month)}-${pad2(day)}`;
  }

  const asNum = Number(s0);
  if (s0 === String(asNum) && Number.isFinite(asNum) && asNum === Math.floor(asNum)) {
    const fromEx = fromExcelSerial(asNum);
    if (fromEx) return fromEx;
  }

  const forParse = frenchMonthsToEnglish(s0);
  const t = Date.parse(forParse);
  if (!Number.isNaN(t)) {
    const d = new Date(t);
    const y = d.getFullYear();
    const m = d.getMonth() + 1;
    const day = d.getDate();
    if (isValidYMD(y, m, day)) return `${y}-${pad2(m)}-${pad2(day)}`;
  }

  return null;
}

/**
 * @param {string|number|null|undefined} raw
 * @returns {string|null} normalized SQL date or null if empty
 * @throws {Error} with code INVALID_DATE_OF_BIRTH_CODE if non-empty but invalid
 */
export function normalizeDateOfBirthForDb(raw) {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s) return null;
  const sql = parseFlexibleDateToMySQL(s);
  if (!sql) {
    const err = new Error(`Could not parse date of birth: "${s.slice(0, 80)}${s.length > 80 ? "…" : ""}"`);
    err.code = INVALID_DATE_OF_BIRTH_CODE;
    throw err;
  }
  return sql;
}
