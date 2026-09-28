// src/models/referenceModel.js
//
// Country and destination-zone reference data.
//
// SINGLE SOURCE OF TRUTH: `destination_zones` holds every ISO country with its
// English and French name plus its pricing zone. The web UI resolves the same
// names through i18n-iso-countries on the client, so chat and web always show a
// customer the same label for the same stored value.
//
// The distinction that matters:
//   listCountries()    — every country, used for nationality and country of
//                        residence. Never filtered by `active`, because
//                        switching a DESTINATION off must not stop a Syrian
//                        national from buying a policy.
//   listDestinations() — only active rows, used for where the customer travels.
//
import getPool from "../utils/db.js";

const SELECT_COLS = "country_code, country_name_en, country_name_fr, zone, active";

function mapRow(row) {
  return {
    code: row.country_code,
    name_en: row.country_name_en,
    name_fr: row.country_name_fr,
    zone: row.zone,
    active: Boolean(row.active),
  };
}

export async function listCountries() {
  const pool = getPool();
  const [rows] = await pool.query(
    `SELECT ${SELECT_COLS} FROM destination_zones ORDER BY country_name_en ASC`
  );
  return rows.map(mapRow);
}

export async function listDestinations() {
  const pool = getPool();
  const [rows] = await pool.query(
    `SELECT ${SELECT_COLS} FROM destination_zones WHERE active = 1 ORDER BY country_name_en ASC`
  );
  return rows.map(mapRow);
}

export async function getCountryByCode(code) {
  const pool = getPool();
  const [rows] = await pool.query(
    `SELECT ${SELECT_COLS} FROM destination_zones WHERE country_code = ? LIMIT 1`,
    [String(code || "").toUpperCase()]
  );
  return rows.length ? mapRow(rows[0]) : null;
}

/** Distinct zones in use, with how many countries each covers. */
export async function listZones() {
  const pool = getPool();
  const [rows] = await pool.query(
    `SELECT zone, COUNT(*) AS country_count, SUM(active = 1) AS active_count
     FROM destination_zones
     GROUP BY zone
     ORDER BY zone ASC`
  );
  return rows.map((r) => ({
    zone: r.zone,
    countryCount: Number(r.country_count),
    activeCount: Number(r.active_count),
  }));
}

/**
 * Reassign countries to a zone. Additive by nature — an UPDATE of the `zone`
 * column only; no row is ever removed, and unknown codes are reported back
 * rather than silently ignored.
 */
export async function assignZone(countryCodes, zone, { deactivate = null } = {}) {
  const codes = (Array.isArray(countryCodes) ? countryCodes : [countryCodes])
    .map((c) => String(c || "").toUpperCase())
    .filter(Boolean);
  if (!codes.length) return { updated: 0, unknown: [] };

  const pool = getPool();
  const placeholders = codes.map(() => "?").join(",");

  const [existing] = await pool.query(
    `SELECT country_code FROM destination_zones WHERE country_code IN (${placeholders})`,
    codes
  );
  const found = new Set(existing.map((r) => r.country_code));
  const unknown = codes.filter((c) => !found.has(c));
  const known = codes.filter((c) => found.has(c));
  if (!known.length) return { updated: 0, unknown };

  const knownPlaceholders = known.map(() => "?").join(",");
  const sets = ["zone = ?"];
  const params = [zone];
  if (deactivate !== null) {
    sets.push("active = ?");
    params.push(deactivate ? 0 : 1);
  }
  const [result] = await pool.query(
    `UPDATE destination_zones SET ${sets.join(", ")} WHERE country_code IN (${knownPlaceholders})`,
    [...params, ...known]
  );
  return { updated: result.affectedRows, unknown };
}
