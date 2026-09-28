// src/controllers/quoteController.js
//
// The quoting API — the pricing engine finally exposed as a product.
//
// WHY THIS IS PART OF THE WHATSAPP MILESTONE: the conversation needs to price a
// traveller before any policy exists. That capability did not previously exist as
// an endpoint — the web app computed premiums in the browser and the API only
// accepted an already-priced case. Building it for WhatsApp and NOT exposing it
// to partners would mean writing the same thing twice later.
//
//   POST /api/quotes/price   price without storing anything (quotes:read)
//   POST /api/quotes         price and store as a case (quotes:write)
//   GET  /api/quotes         list stored quotes (quotes:read)
//   GET  /api/quotes/:ref    one stored quote (quotes:read)
//
import {
  validateName,
  validatePassportNumber,
  validateEmail,
  validatePhoneE164,
  validateDateOfBirth,
  validateGender,
  validateTravelDates,
} from "../utils/validators.js";
import { computeQuote, computeQuotesForPlans, parsePricingRules } from "../utils/quoteEngine.js";
import { getCountries, getDestinations, matchCountry } from "../utils/referenceData.js";
import { getCountryByCode } from "../models/referenceModel.js";
import { listWhatsAppPlans, getPlanById, createQuote, getQuoteByReference, listQuotes } from "../models/quoteModel.js";
import { getWhatsAppConfig } from "../utils/appSettings.js";
import getPool from "../utils/db.js";
import { logActivity } from "../models/activityModel.js";

const ok = (res, data, extra = {}) => res.json({ success: true, data, ...extra });
const fail = (res, status, code, message, extra = {}) =>
  res.status(status).json({ success: false, error: { code, message, ...extra } });

/** Resolve a destination given either an ISO code or a country name. */
async function resolveDestination({ destination_code, destination }) {
  if (destination_code) {
    const byCode = await getCountryByCode(destination_code);
    if (byCode) return { ok: true, country: byCode };
    return { ok: false, message: `Unknown destination_code: ${destination_code}` };
  }
  if (destination) {
    const list = await getDestinations();
    const { match, candidates } = matchCountry(destination, list);
    if (match) return { ok: true, country: match };
    return {
      ok: false,
      message: `Could not resolve destination "${destination}"`,
      candidates: candidates.map((c) => ({ code: c.code, name: c.name_en })),
    };
  }
  return { ok: false, message: "destination or destination_code is required" };
}

/**
 * Validate the traveller/travel payload shared by both quote endpoints.
 * Collects EVERY field error rather than failing on the first, so an integrator
 * fixes their payload in one pass.
 */
function validateQuoteInput(body, { requireContact }) {
  const errors = [];
  const out = {};

  const dob = validateDateOfBirth(body.date_of_birth);
  if (!dob.ok) errors.push({ field: "date_of_birth", code: dob.code, message: dob.message });
  else out.date_of_birth = dob.value;

  const dates = validateTravelDates(body.start_date, body.end_date);
  if (!dates.ok) errors.push({ field: dates.field || "start_date", code: dates.code, message: dates.message });
  else Object.assign(out, dates.value);

  if (requireContact) {
    for (const [field, validator, label] of [
      ["first_name", (v) => validateName(v, "First name"), "First name"],
      ["last_name", (v) => validateName(v, "Last name"), "Last name"],
      ["passport_or_id", validatePassportNumber, "Passport"],
      ["email", validateEmail, "Email"],
    ]) {
      const r = validator(body[field]);
      if (!r.ok) errors.push({ field, code: r.code, message: r.message });
      else out[field] = r.value;
    }

    if (body.phone) {
      const phone = validatePhoneE164(body.phone);
      if (!phone.ok) errors.push({ field: "phone", code: phone.code, message: phone.message });
      else out.phone = phone.value;
    }
    if (body.gender) {
      const gender = validateGender(body.gender);
      if (!gender.ok) errors.push({ field: "gender", code: gender.code, message: gender.message });
      else out.gender = gender.value;
    }
  }

  return { ok: errors.length === 0, errors, value: out };
}

/* --------------------------------------------- POST /api/quotes/price */

/**
 * Price a traveller without storing anything.
 *
 * With `plan_id` it prices that plan; without one it prices every plan the caller
 * could sell, cheapest first, and reports the ones it could not price and why.
 */
export const priceQuote = async (req, res) => {
  try {
    const body = req.body || {};
    const validated = validateQuoteInput(body, { requireContact: false });
    if (!validated.ok) {
      return fail(res, 400, "validation_error", "Some fields are invalid", { fields: validated.errors });
    }

    const destination = await resolveDestination(body);
    if (!destination.ok) {
      return fail(res, 400, "destination_unresolved", destination.message, { candidates: destination.candidates });
    }

    const { date_of_birth, start_date, end_date } = validated.value;

    if (body.plan_id) {
      const plan = await getPlanById(Number(body.plan_id));
      if (!plan) return fail(res, 404, "plan_not_found", "Plan not found");
      const result = computeQuote({ plan, destination: destination.country, startDate: start_date, endDate: end_date, dateOfBirth: date_of_birth });
      if (!result.ok) return fail(res, 422, result.code, result.message, { details: result.details });
      return ok(res, { quote: result.quote });
    }

    const plans = await listQuotablePlans(req);
    if (!plans.length) {
      return fail(res, 404, "no_plans_available", "No plans are available to quote");
    }

    const { priced, rejected } = computeQuotesForPlans({
      plans, destination: destination.country, startDate: start_date, endDate: end_date, dateOfBirth: date_of_birth,
    });
    if (!priced.length) {
      return fail(res, 422, "no_price_for_inputs", "No plan could be priced for these inputs", { rejected });
    }

    return ok(res, { quotes: priced, rejected });
  } catch (err) {
    console.error("priceQuote failed:", err);
    return fail(res, 500, "pricing_failed", "Could not price this request");
  }
};

/**
 * Plans the caller may quote.
 *
 * A JWT-authenticated staff user sees every active plan (the same set the web app
 * offers). An API key is restricted to plans flagged for programmatic sale, so a
 * partner cannot quote a plan the client has not published to them.
 */
async function listQuotablePlans(req) {
  if (req.authMode === "api_key") return listWhatsAppPlans();
  const pool = getPool();
  const [rows] = await pool.query(`SELECT * FROM catalogue WHERE active = 1 ORDER BY name ASC`);
  return rows;
}

/* --------------------------------------------------- POST /api/quotes */

export const createQuoteController = async (req, res) => {
  try {
    const body = req.body || {};
    const validated = validateQuoteInput(body, { requireContact: true });
    if (!validated.ok) {
      return fail(res, 400, "validation_error", "Some fields are invalid", { fields: validated.errors });
    }
    if (!body.plan_id) {
      return fail(res, 400, "validation_error", "plan_id is required", {
        fields: [{ field: "plan_id", code: "required", message: "plan_id is required" }],
      });
    }

    const destination = await resolveDestination(body);
    if (!destination.ok) {
      return fail(res, 400, "destination_unresolved", destination.message, { candidates: destination.candidates });
    }

    const v = validated.value;

    // Attribution: an API key acts as its owner; our own UI acts as the logged-in
    // user; a WhatsApp-originated quote uses the account named in settings.
    let createdBy = req.user?.id || null;
    if (body.source === "whatsapp") {
      const config = await getWhatsAppConfig();
      createdBy = config.attributionUserId || createdBy;
    }

    const result = await createQuote({
      traveller: {
        first_name: v.first_name,
        last_name: v.last_name,
        date_of_birth: v.date_of_birth,
        gender: v.gender || null,
        nationality: body.nationality || null,
        country_of_residence: body.country_of_residence || null,
        passport_or_id: v.passport_or_id,
        email: v.email,
        phone: v.phone || null,
        whatsapp_number: body.whatsapp_number || null,
        preferred_language: body.language || null,
      },
      travel: {
        destination: destination.country.name_en,
        destination_code: destination.country.code,
        start_date: v.start_date,
        end_date: v.end_date,
      },
      planId: Number(body.plan_id),
      createdBy,
      source: body.source === "whatsapp" ? "whatsapp" : "api",
    });

    if (!result.ok) {
      const status = result.code === "age_ineligible" ? 422
        : result.code === "plan_not_found" ? 404
        : result.code === "attribution_missing" ? 409
        : result.code === "no_price" ? 422
        : 500;
      return fail(res, status, result.code, result.message);
    }

    if (req.user?.id) {
      await logActivity(req.user.id, `Created quote ${result.quoteReference}`).catch(() => {});
    }

    return res.status(201).json({
      success: true,
      data: {
        quote_reference: result.quoteReference,
        case_id: result.caseId,
        traveller_id: result.travellerId,
        status: "AwaitingPayment",
        pricing: result.pricing,
        quote: result.quote,
      },
      message: "Quote created. Confirm the sale to issue a policy.",
    });
  } catch (err) {
    console.error("createQuoteController failed:", err);
    return fail(res, 500, "quote_create_failed", "Could not create the quote");
  }
};

/* ------------------------------------------------------ GET /api/quotes */

export const listQuotesController = async (req, res) => {
  try {
    // An API key sees only what its owner owns; staff JWTs see everything, as
    // elsewhere in this API.
    const createdBy = req.authMode === "api_key" ? req.user.id : (req.query.created_by || null);
    const result = await listQuotes({
      page: req.query.page,
      limit: req.query.limit,
      source: req.query.source || null,
      status: req.query.status || null,
      createdBy,
    });
    return ok(res, result.quotes, { pagination: result.pagination });
  } catch (err) {
    console.error("listQuotesController failed:", err);
    return fail(res, 500, "quotes_read_failed", "Could not load the quotes");
  }
};

export const getQuoteController = async (req, res) => {
  try {
    const row = await getQuoteByReference(String(req.params.reference));
    if (!row) return fail(res, 404, "not_found", "Quote not found");

    if (req.authMode === "api_key" && row.created_by !== req.user.id) {
      // Same shape as "not found": an API key must not be able to probe for the
      // existence of another partner's quote references.
      return fail(res, 404, "not_found", "Quote not found");
    }

    // Recompute so a caller always sees the CURRENT price for the stored inputs,
    // and can tell when the catalogue has moved since the quote was taken.
    const destination = row.destination ? (await getDestinations()).find((c) => c.name_en === row.destination) || null : null;
    const priced = computeQuote({
      plan: {
        id: row.plan_id, name: row.plan_name, product_type: row.product_type, currency: row.currency,
        pricing_rules: parsePricingRules(row.pricing_rules), flat_price: row.flat_price,
        fixed_duration_premiums: row.fixed_duration_premiums,
        coverage_summary_fr: row.coverage_summary_fr, coverage_summary_en: row.coverage_summary_en,
      },
      destination,
      startDate: toYmd(row.start_date),
      endDate: toYmd(row.end_date),
      dateOfBirth: toYmd(row.date_of_birth),
    });

    return ok(res, {
      quote_reference: row.quote_reference,
      case_id: row.case_id,
      status: row.status,
      source: row.source,
      created_at: row.created_at,
      traveller: {
        id: row.traveller_id, first_name: row.first_name, last_name: row.last_name,
        date_of_birth: toYmd(row.date_of_birth), gender: row.gender, nationality: row.nationality,
        country_of_residence: row.country_of_residence, passport_or_id: row.passport_or_id,
        email: row.email, phone: row.phone, whatsapp_number: row.whatsapp_number,
      },
      travel: {
        destination: row.destination, start_date: toYmd(row.start_date),
        end_date: toYmd(row.end_date), duration_days: row.duration_days,
      },
      plan: { id: row.plan_id, name: row.plan_name, product_type: row.product_type, currency: row.currency },
      pricing: priced.ok ? priced.quote.pricing : null,
      pricing_error: priced.ok ? null : { code: priced.code, message: priced.message },
      sale: row.sale_id
        ? { id: row.sale_id, policy_number: row.policy_number, certificate_number: row.certificate_number, payment_status: row.payment_status }
        : null,
    });
  } catch (err) {
    console.error("getQuoteController failed:", err);
    return fail(res, 500, "quote_read_failed", "Could not load the quote");
  }
};

/**
 * Serialise a DATE column as YYYY-MM-DD.
 *
 * NOT toISOString(): mysql2 hands a DATE back as a Date at LOCAL midnight, so
 * converting to UTC shifts it a day earlier on any server east of Greenwich.
 * The production VPS and the client both sit in positive offsets, so every
 * travel date and date of birth would have read one day early. Local date parts
 * are the only correct reading of a timezone-less DATE column.
 */
function toYmd(value) {
  if (!value) return null;
  if (value instanceof Date) {
    const y = value.getFullYear();
    const m = String(value.getMonth() + 1).padStart(2, "0");
    const d = String(value.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }
  return String(value).slice(0, 10);
}
