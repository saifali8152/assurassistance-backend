/**
 * Map free-text / Excel gender values to DB ENUM('Male', 'Female', 'Other').
 */

function normKey(s) {
  return String(s || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\.$/, "")
    .replace(/\s+/g, " ");
}

/** @type {Record<string, 'Male' | 'Female' | 'Other'>} */
const MAP = {
  m: "Male",
  male: "Male",
  man: "Male",
  boy: "Male",
  homme: "Male",
  masculin: "Male",
  masculine: "Male",
  monsieur: "Male",
  mr: "Male",
  h: "Male",
  garcon: "Male",
  f: "Female",
  female: "Female",
  woman: "Female",
  girl: "Female",
  femme: "Female",
  feminin: "Female",
  madame: "Female",
  mme: "Female",
  mrs: "Female",
  ms: "Female",
  miss: "Female",
  mademoiselle: "Female",
  o: "Other",
  x: "Other",
  other: "Other",
  autre: "Other",
  autres: "Other",
  na: "Other",
  "n/a": "Other",
  unknown: "Other",
  unspecified: "Other",
  nonbinary: "Other",
  "non-binary": "Other",
  nb: "Other",
  intersex: "Other",
  divers: "Other"
};

/**
 * @param {string} raw non-empty trimmed user input
 * @returns {'Male' | 'Female' | 'Other'}
 */
export function normalizeGenderForDb(raw) {
  const n = normKey(raw);
  if (!n) return "Other";
  if (MAP[n]) return MAP[n];
  if (n.startsWith("male") || n.startsWith("homme") || n.startsWith("mascul")) return "Male";
  if (n.startsWith("female") || n.startsWith("femme") || n.startsWith("femin")) return "Female";
  return "Other";
}

/**
 * @param {unknown} gender
 * @returns {string|null} 'Male' | 'Female' | 'Other' or null if empty
 */
export function coerceGenderForDb(gender) {
  if (gender == null) return null;
  const s = String(gender).trim();
  if (!s) return null;
  return normalizeGenderForDb(s);
}
