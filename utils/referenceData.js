// src/utils/referenceData.js
//
// Cached country/zone lookups, fuzzy matching, and WhatsApp list pagination.
//
// THE WHATSAPP CONSTRAINT that shapes this file: an interactive list message may
// contain at most 10 rows. There are 195 countries. Three strategies, in order:
//
//   1. The customer types a name — fuzzy match resolves it in one message. This
//      is the fast path and the one most customers take.
//   2. Ambiguous input (2–10 candidates) — show those candidates as a list.
//   3. No usable input — offer alphabetical groups (A–C, D–F, …), then the
//      countries inside the chosen group, paginated 9 + "More".
//
// Alphabetical grouping is used rather than regions because it needs no data we
// would have to invent, and every customer already knows the alphabet.
//
import {
  listCountries,
  listDestinations,
  listZones,
  getCountryByCode,
} from "../models/referenceModel.js";

const CACHE_TTL_MS = 5 * 60 * 1000;

const cache = {
  countries: { data: null, at: 0 },
  destinations: { data: null, at: 0 },
  zones: { data: null, at: 0 },
};

function fresh(slot) {
  return slot.data && Date.now() - slot.at < CACHE_TTL_MS;
}

export function invalidateReferenceData() {
  cache.countries = { data: null, at: 0 };
  cache.destinations = { data: null, at: 0 };
  cache.zones = { data: null, at: 0 };
}

export async function getCountries() {
  if (fresh(cache.countries)) return cache.countries.data;
  const data = await listCountries();
  cache.countries = { data, at: Date.now() };
  return data;
}

export async function getDestinations() {
  if (fresh(cache.destinations)) return cache.destinations.data;
  const data = await listDestinations();
  cache.destinations = { data, at: Date.now() };
  return data;
}

export async function getZones() {
  if (fresh(cache.zones)) return cache.zones.data;
  const data = await listZones();
  cache.zones = { data, at: Date.now() };
  return data;
}

export { getCountryByCode };

/** The label a customer should see, in their language. */
export function countryLabel(country, lang = "fr") {
  if (!country) return "";
  return lang === "en" ? country.name_en : country.name_fr;
}

/* ------------------------------------------------------------ fuzzy matching */

/** Strip accents, punctuation and case so "Côte-d'Ivoire" ≈ "cote divoire". */
export function normalizeForMatch(s) {
  return String(s ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

/** Levenshtein distance, capped for speed — we only care about small edits. */
function editDistance(a, b, max = 3) {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (cur[j] < rowMin) rowMin = cur[j];
    }
    if (rowMin > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}

/**
 * Match free text against a country list, in both languages and by ISO code.
 *
 * Returns { match, candidates }:
 *   match      — a single confident result, or null
 *   candidates — the shortlist to offer when there is no single confident match
 *
 * Confidence rules, strictest first: exact ISO code, exact name, unique prefix,
 * unique substring, then a unique near-miss within two edits (which catches
 * "Fance" and "Espagn"). Anything with several plausible answers returns
 * candidates instead of guessing, because silently quoting the wrong destination
 * is far worse than one extra message.
 */
export function matchCountry(input, countries, { limit = 10 } = {}) {
  const q = normalizeForMatch(input);
  const raw = String(input ?? "").trim();
  if (!q) return { match: null, candidates: [] };

  if (/^[A-Za-z]{2}$/.test(raw)) {
    const byCode = countries.find((c) => c.code === raw.toUpperCase());
    if (byCode) return { match: byCode, candidates: [] };
  }

  const indexed = countries.map((c) => ({
    country: c,
    en: normalizeForMatch(c.name_en),
    fr: normalizeForMatch(c.name_fr),
  }));

  const exact = indexed.filter((x) => x.en === q || x.fr === q);
  if (exact.length === 1) return { match: exact[0].country, candidates: [] };
  if (exact.length > 1) return { match: null, candidates: exact.slice(0, limit).map((x) => x.country) };

  const prefix = indexed.filter((x) => x.en.startsWith(q) || x.fr.startsWith(q));
  if (prefix.length === 1) return { match: prefix[0].country, candidates: [] };
  if (prefix.length > 1) return { match: null, candidates: prefix.slice(0, limit).map((x) => x.country) };

  if (q.length >= 3) {
    const contains = indexed.filter((x) => x.en.includes(q) || x.fr.includes(q));
    if (contains.length === 1) return { match: contains[0].country, candidates: [] };
    if (contains.length > 1) return { match: null, candidates: contains.slice(0, limit).map((x) => x.country) };
  }

  if (q.length >= 4) {
    const near = indexed
      .map((x) => ({ x, d: Math.min(editDistance(q, x.en), editDistance(q, x.fr)) }))
      .filter((r) => r.d <= 2)
      .sort((a, b) => a.d - b.d);
    if (near.length === 1) return { match: near[0].x.country, candidates: [] };
    if (near.length > 1) {
      const best = near[0].d;
      const tied = near.filter((r) => r.d === best);
      if (tied.length === 1) return { match: tied[0].x.country, candidates: [] };
      return { match: null, candidates: near.slice(0, limit).map((r) => r.x.country) };
    }
  }

  return { match: null, candidates: [] };
}

/* ------------------------------------------------- alphabetical browse mode */

const ALPHA_GROUPS = [
  ["A", "C"], ["D", "F"], ["G", "I"], ["J", "L"], ["M", "O"],
  ["P", "R"], ["S", "U"], ["V", "Z"],
];

/** Alphabetical groups that actually contain countries, for a list message. */
export function alphaGroups(countries, lang = "fr") {
  return ALPHA_GROUPS.map(([from, to]) => {
    const members = countries.filter((c) => {
      const initial = (countryLabel(c, lang)[0] || "").toUpperCase();
      return initial >= from && initial <= to;
    });
    return { id: `alpha:${from}${to}`, label: `${from} – ${to}`, count: members.length };
  }).filter((g) => g.count > 0);
}

export function countriesInAlphaGroup(countries, groupId, lang = "fr") {
  const m = /^alpha:([A-Z])([A-Z])$/.exec(String(groupId || ""));
  if (!m) return [];
  const [, from, to] = m;
  return countries
    .filter((c) => {
      const initial = (countryLabel(c, lang)[0] || "").toUpperCase();
      return initial >= from && initial <= to;
    })
    .sort((a, b) => countryLabel(a, lang).localeCompare(countryLabel(b, lang), lang));
}

/**
 * Slice a list into a WhatsApp-sized page.
 *
 * `rowBudget` defaults to 9 rather than 10 so there is always room for the
 * "More" row without pushing the list over Meta's limit.
 */
export function paginate(items, page = 0, rowBudget = 9) {
  const start = page * rowBudget;
  const slice = items.slice(start, start + rowBudget);
  return {
    items: slice,
    page,
    hasMore: start + rowBudget < items.length,
    total: items.length,
    pages: Math.max(1, Math.ceil(items.length / rowBudget)),
  };
}

/* ----------------------------------------------------------- zone resolution */

/**
 * Resolve the pricing column to use for a destination.
 *
 * The premium engine picks a price from `pricing_rules.pricingColumns`. Today
 * plans carry a single "Worldwide" column, so this returns that and pricing is
 * unchanged. Once the client supplies a real zone map, the country's zone is
 * used when the plan defines a matching column, and otherwise we fall back to
 * the plan's first column — the same price it charges today — rather than
 * failing a sale over a gap in reference data.
 */
export function resolveZoneColumn(pricingTables, zone) {
  const columns = Array.isArray(pricingTables?.pricingColumns) ? pricingTables.pricingColumns : [];
  if (!columns.length) return { column: null, matched: false, columns: [] };

  if (zone) {
    const wanted = normalizeForMatch(zone);
    const hit = columns.find((c) => normalizeForMatch(c) === wanted);
    if (hit) return { column: hit, matched: true, columns };
  }
  return { column: columns[0], matched: false, columns };
}

/**
 * Reorder a plan's pricing columns so the resolved zone is tried first.
 *
 * Returning a NEW object and leaving travelPricing.js untouched is deliberate:
 * the web app's pricing path keeps running exactly the code it runs today, so
 * zone support cannot regress existing quotes.
 */
export function pricingTablesForZone(pricingTables, zone) {
  const { column, matched, columns } = resolveZoneColumn(pricingTables, zone);
  if (!column) return { tables: pricingTables, column: null, matched: false };
  const reordered = [column, ...columns.filter((c) => c !== column)];
  return {
    tables: { ...pricingTables, pricingColumns: reordered },
    column,
    matched,
  };
}
