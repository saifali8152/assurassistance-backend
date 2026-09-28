// src/controllers/zoneController.js
//
// Destination zones: the country → pricing-zone map.
//
// Exposed because a partner pricing a trip needs to know which zone a country
// falls into (and therefore why two destinations cost differently), and because
// the superadmin needs to maintain the map once the client supplies it.
//
//   GET   /api/zones                 zones in use, with country counts (zones:read)
//   GET   /api/zones/countries       the full map (zones:read)
//   GET   /api/zones/resolve?country=CI   one lookup (zones:read)
//   PATCH /api/zones/assign          reassign countries (admin JWT only)
//
import { getZones, getCountries, invalidateReferenceData, matchCountry } from "../utils/referenceData.js";
import { assignZone, getCountryByCode } from "../models/referenceModel.js";
import { logActivity } from "../models/activityModel.js";

const ok = (res, data, extra = {}) => res.json({ success: true, data, ...extra });
const fail = (res, status, code, message, extra = {}) =>
  res.status(status).json({ success: false, error: { code, message, ...extra } });

export const listZonesController = async (_req, res) => {
  try {
    return ok(res, await getZones());
  } catch (err) {
    console.error("listZones failed:", err);
    return fail(res, 500, "zones_read_failed", "Could not load the zones");
  }
};

export const listZoneCountriesController = async (req, res) => {
  try {
    const all = await getCountries();
    const zone = req.query.zone ? String(req.query.zone) : null;
    const filtered = zone ? all.filter((c) => c.zone === zone) : all;
    return ok(
      res,
      filtered.map((c) => ({
        country_code: c.code,
        name_en: c.name_en,
        name_fr: c.name_fr,
        zone: c.zone,
        active: c.active,
      }))
    );
  } catch (err) {
    console.error("listZoneCountries failed:", err);
    return fail(res, 500, "zones_read_failed", "Could not load the country map");
  }
};

/** Accepts an ISO code or a country name in either language. */
export const resolveZoneController = async (req, res) => {
  try {
    const query = String(req.query.country || "").trim();
    if (!query) return fail(res, 400, "validation_error", "`country` is required");

    if (/^[A-Za-z]{2}$/.test(query)) {
      const byCode = await getCountryByCode(query);
      if (byCode) return ok(res, present(byCode));
    }

    const { match, candidates } = matchCountry(query, await getCountries());
    if (match) return ok(res, present(match));

    return fail(res, 404, "not_found", `Could not resolve "${query}"`, {
      candidates: candidates.map((c) => ({ country_code: c.code, name_en: c.name_en })),
    });
  } catch (err) {
    console.error("resolveZone failed:", err);
    return fail(res, 500, "zone_resolve_failed", "Could not resolve that country");
  }
};

/**
 * Reassign countries to a zone.
 *
 * An UPDATE of one column; no row is created or removed, so an operator cannot
 * lose a country by mis-typing. Unknown codes are reported back rather than
 * silently ignored.
 */
export const assignZoneController = async (req, res) => {
  try {
    const { country_codes: codes, zone, active } = req.body || {};
    if (!zone || !String(zone).trim()) return fail(res, 400, "validation_error", "`zone` is required");
    if (!Array.isArray(codes) || !codes.length) {
      return fail(res, 400, "validation_error", "`country_codes` must be a non-empty array");
    }
    if (codes.length > 300) return fail(res, 400, "validation_error", "Too many countries in one request");

    const result = await assignZone(codes, String(zone).trim(), {
      deactivate: active === undefined ? null : !active,
    });
    invalidateReferenceData();

    await logActivity(req.user.id, `Assigned ${result.updated} country/countries to zone "${zone}"`).catch(() => {});

    return ok(res, { updated: result.updated, unknown: result.unknown, zone: String(zone).trim() }, {
      message: result.unknown.length
        ? `Updated ${result.updated}; ${result.unknown.length} code(s) were not recognised`
        : `Updated ${result.updated} country/countries`,
    });
  } catch (err) {
    console.error("assignZone failed:", err);
    return fail(res, 500, "zone_assign_failed", "Could not update the zones");
  }
};

function present(c) {
  return { country_code: c.code, name_en: c.name_en, name_fr: c.name_fr, zone: c.zone, active: c.active };
}
