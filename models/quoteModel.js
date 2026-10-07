// src/models/quoteModel.js
//
// Persisting a quote as a `cases` row (plus its traveller).
//
// WHY NOT REUSE caseModel.createCase(): that function is on the web app's hot
// path and does not know about the new `quote_reference`, `source` or
// `whatsapp_number` columns. Extending it would put the existing sales flow at
// risk for no benefit, so the WhatsApp/API path gets its own inserts. The SHAPE
// of the data is identical, which is what matters — a WhatsApp quote is an
// ordinary case and the existing sale, certificate and invoice chain works on it
// unchanged.
//
// WHY THE PREMIUM IS RECOMPUTED HERE: the number in the conversation session came
// from a message the customer was shown, and a session can be hours old. Prices
// and the catalogue can change in between. The premium written to the database is
// always recalculated from the live catalogue at the moment of persistence.
//
import getPool from "../utils/db.js";
import { passportColumns, hydrateTravellers } from "../utils/travellerPrivacy.js";
import { computeQuote, generateQuoteReference } from "../utils/quoteEngine.js";
import { getCountryByCode } from "./referenceModel.js";

/** Plans sellable over WhatsApp: active, flagged, and actually priceable. */
export async function listWhatsAppPlans() {
  const pool = getPool();
  const [rows] = await pool.query(
    `SELECT * FROM catalogue WHERE active = 1 AND whatsapp_enabled = 1 ORDER BY name ASC`
  );
  return rows;
}

export async function getPlanById(planId) {
  const pool = getPool();
  const [rows] = await pool.query(`SELECT * FROM catalogue WHERE id = ? LIMIT 1`, [planId]);
  return rows[0] || null;
}

/** Reference generation retries on the (astronomically unlikely) collision. */
async function reserveQuoteReference(conn) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const reference = generateQuoteReference();
    const [rows] = await conn.query(
      `SELECT id FROM cases WHERE quote_reference = ? LIMIT 1`,
      [reference]
    );
    if (!rows.length) return reference;
  }
  throw new Error("Could not allocate a unique quote reference");
}

/**
 * Create a traveller + case for a quote.
 *
 * @param {object} args
 * @param {object} args.traveller  { first_name, last_name, date_of_birth, gender,
 *                                   nationality, country_of_residence,
 *                                   passport_or_id, email, phone, whatsapp_number }
 * @param {object} args.travel     { destination, destination_code, start_date, end_date }
 * @param {number} args.planId
 * @param {number} args.createdBy  owning user account (attribution)
 * @param {'web'|'whatsapp'|'api'} args.source
 *
 * @returns {Promise<{ok: true, quoteReference, caseId, travellerId, pricing}
 *                 | {ok: false, code, message}>}
 */
export async function createQuote({ traveller, travel, planId, createdBy, source = "api" }) {
  if (!createdBy) {
    return {
      ok: false,
      code: "attribution_missing",
      message:
        "No owning account is configured for this source. Set the attribution account in the WhatsApp settings.",
    };
  }

  const plan = await getPlanById(planId);
  if (!plan) return { ok: false, code: "plan_not_found", message: "Plan not found" };
  if (!plan.active) return { ok: false, code: "plan_inactive", message: "That plan is no longer available" };

  const destination = travel.destination_code ? await getCountryByCode(travel.destination_code) : null;

  // Authoritative pricing: live catalogue, live zone map, at this instant.
  const priced = computeQuote({
    plan,
    destination,
    startDate: travel.start_date,
    endDate: travel.end_date,
    dateOfBirth: traveller.date_of_birth,
  });
  if (!priced.ok) {
    return {
      ok: false,
      code: priced.code === "age_ineligible" ? "age_ineligible" : "no_price",
      message: priced.message,
    };
  }

  const pool = getPool();
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [travellerResult] = await conn.execute(
      `INSERT INTO travellers
         (first_name, last_name, date_of_birth, country_of_residence, gender, nationality,
          passport_or_id, passport_or_id_enc, passport_or_id_hash, phone, email, address,
          whatsapp_number, source, preferred_language)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
      [
        traveller.first_name || null,
        traveller.last_name || null,
        traveller.date_of_birth || null,
        traveller.country_of_residence || null,
        normaliseGender(traveller.gender),
        traveller.nationality || null,
        ...(() => {
          const cols = passportColumns(traveller.passport_or_id);
          return [cols.passport_or_id, cols.passport_or_id_enc, cols.passport_or_id_hash];
        })(),
        traveller.phone || null,
        traveller.email || null,
        traveller.whatsapp_number || null,
        source,
        traveller.preferred_language || null,
      ]
    );
    const travellerId = travellerResult.insertId;

    const quoteReference = await reserveQuoteReference(conn);

    const [caseResult] = await conn.execute(
      `INSERT INTO cases
         (traveller_id, destination, start_date, end_date, selected_plan_id, created_by,
          status, quote_reference, source)
       VALUES (?, ?, ?, ?, ?, ?, 'AwaitingPayment', ?, ?)`,
      [
        travellerId,
        travel.destination || null,
        travel.start_date,
        travel.end_date,
        planId,
        createdBy,
        quoteReference,
        source,
      ]
    );

    await conn.commit();

    return {
      ok: true,
      quoteReference,
      caseId: caseResult.insertId,
      travellerId,
      pricing: priced.quote.pricing,
      quote: priced.quote,
    };
  } catch (err) {
    await conn.rollback();
    return { ok: false, code: "persist_failed", message: err.message };
  } finally {
    conn.release();
  }
}

/** Gender column is an ENUM('Male','Female','Other'); anything else stores NULL. */
function normaliseGender(value) {
  const s = String(value || "").trim().toLowerCase();
  if (["male", "m", "homme"].includes(s)) return "Male";
  if (["female", "f", "femme"].includes(s)) return "Female";
  if (["other", "autre", "o"].includes(s)) return "Other";
  return null;
}

/** One quote by its customer-facing reference, with everything needed to show it. */
export async function getQuoteByReference(reference) {
  const pool = getPool();
  const [rows] = await pool.query(
    `SELECT c.id AS case_id, c.quote_reference, c.status, c.source, c.destination,
            c.start_date, c.end_date, c.duration_days, c.created_at, c.created_by,
            t.id AS traveller_id, t.first_name, t.last_name, t.date_of_birth, t.gender,
            t.nationality, t.country_of_residence, t.passport_or_id, t.passport_or_id_enc, t.email, t.phone,
            t.whatsapp_number, t.preferred_language,
            cat.id AS plan_id, cat.name AS plan_name, cat.product_type, cat.currency,
            cat.pricing_rules, cat.flat_price, cat.fixed_duration_premiums,
            cat.coverage_summary_fr, cat.coverage_summary_en,
            s.id AS sale_id, s.policy_number, s.certificate_number, s.payment_status
     FROM cases c
     JOIN travellers t ON c.traveller_id = t.id
     JOIN catalogue cat ON c.selected_plan_id = cat.id
     LEFT JOIN sales s ON s.case_id = c.id
     WHERE c.quote_reference = ?
     LIMIT 1`,
    [reference]
  );
  return rows[0] || null;
}

/** Quotes for the API and admin screens, filtered by source and status. */
export async function listQuotes({ page = 1, limit = 25, source = null, status = null, createdBy = null } = {}) {
  const pool = getPool();
  const size = Math.min(100, Math.max(1, Number(limit) || 25));
  const offset = (Math.max(1, Number(page) || 1) - 1) * size;

  const where = ["c.quote_reference IS NOT NULL"];
  const params = [];
  if (source) { where.push("c.source = ?"); params.push(source); }
  if (status) { where.push("c.status = ?"); params.push(status); }
  if (createdBy) { where.push("c.created_by = ?"); params.push(createdBy); }
  const whereSql = `WHERE ${where.join(" AND ")}`;

  const [rows] = await pool.query(
    `SELECT c.id AS case_id, c.quote_reference, c.status, c.source, c.destination,
            c.start_date, c.end_date, c.duration_days, c.created_at,
            CONCAT(t.first_name, ' ', t.last_name) AS traveller_name,
            t.email, t.phone, t.whatsapp_number,
            cat.name AS plan_name, cat.currency,
            s.id AS sale_id, s.payment_status
     FROM cases c
     JOIN travellers t ON c.traveller_id = t.id
     JOIN catalogue cat ON c.selected_plan_id = cat.id
     LEFT JOIN sales s ON s.case_id = c.id
     ${whereSql}
     ORDER BY c.created_at DESC
     LIMIT ${size} OFFSET ${offset}`,
    params
  );
  const [countRows] = await pool.query(`SELECT COUNT(*) AS total FROM cases c ${whereSql}`, params);
  const total = Number(countRows[0]?.total || 0);

  return {
    quotes: rows,
    pagination: { page: Math.max(1, Number(page) || 1), limit: size, total, pages: Math.max(1, Math.ceil(total / size)) },
  };
}
