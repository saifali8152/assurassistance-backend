// src/models/policyIssuance.js
//
// The one place a policy comes into existence.
//
// There used to be two: POST /api/sales and POST /cases/:id/confirm-sale, with
// different numbering schemes and neither in a transaction. Milestone 3 adds a
// third caller — a confirmed mobile money payment — and three copies of this
// logic would guarantee they drift. So it lives here, once, and all three call
// it.
//
// WHAT IT GUARANTEES
//   * one live sale per case, checked under a row lock and backed by the UNIQUE
//     index from m3_03;
//   * sale, invoice and certificate in a single transaction, so a failure part
//     way leaves nothing behind;
//   * numbers from an allocated sequence, not from Date.now();
//   * a frozen snapshot of what the certificate said, so re-rendering an old
//     policy can never print different figures than the customer's copy.
//
import getPool from "../utils/db.js";
import { createSale } from "./salesModel.js";
import { createInvoice } from "./invoiceModel.js";
import { createCertificate, generatePublicToken } from "./certificateModel.js";
import { allocateSaleNumbers } from "../utils/documentNumbers.js";
import { getNumberFormats } from "../utils/appSettings.js";

/**
 * What the certificate said at the moment it was issued.
 *
 * Deliberately denormalised: the whole point is that it survives an edit to the
 * catalogue, a rename of a plan, or a correction to a traveller record.
 */
function buildSnapshot({ caseRow, pricing, numbers, paid }) {
  return {
    version: 1,
    issued_at: new Date().toISOString(),
    policy_number: numbers.policyNumber,
    certificate_number: numbers.certificateNumber,
    invoice_number: numbers.invoiceNumber,
    traveller: {
      first_name: caseRow.first_name ?? null,
      last_name: caseRow.last_name ?? null,
      date_of_birth: caseRow.date_of_birth ?? null,
      passport_or_id: caseRow.passport_or_id ?? null,
      nationality: caseRow.nationality ?? null,
      country_of_residence: caseRow.country_of_residence ?? null,
      gender: caseRow.gender ?? null,
      email: caseRow.email ?? null,
      phone: caseRow.phone ?? null,
    },
    trip: {
      destination: caseRow.destination ?? null,
      start_date: caseRow.start_date ?? null,
      end_date: caseRow.end_date ?? null,
      duration_days: caseRow.duration_days ?? null,
      validity_days: pricing.validityDays ?? null,
    },
    plan: {
      id: caseRow.plan_id ?? caseRow.selected_plan_id ?? null,
      name: caseRow.plan_name ?? null,
      product_type: caseRow.product_type ?? null,
      coverage: caseRow.coverage ?? null,
    },
    pricing: {
      premium: pricing.premium,
      tax: pricing.tax ?? 0,
      total: pricing.total,
      currency: pricing.currency || "XOF",
      age_band: pricing.ageBand ?? null,
    },
    payment: paid
      ? { method: paid.method || null, reference: paid.reference || null, at: paid.at || new Date().toISOString() }
      : null,
  };
}

/**
 * Issue a policy for a case, or return the one that already exists.
 *
 * @param {object} opts
 * @param {number} opts.caseId
 * @param {object} opts.caseRow   the case with traveller and plan joined
 * @param {object} opts.pricing   {premium, tax, total, currency, validityDays?, ageBand?}
 * @param {object} [opts.paid]    {method, reference, amount} when money has already arrived
 * @returns {Promise<{created: boolean, saleId, policyNumber, certificateNumber, invoiceNumber, invoiceId, certificateId}>}
 */
export async function issuePolicy({ caseId, caseRow, pricing, paid = null }) {
  const pool = getPool();
  const formats = await getNumberFormats();
  const conn = await pool.getConnection();

  try {
    await conn.beginTransaction();

    // Serialise on the case: a second confirmation waits here and then finds
    // the sale the winner wrote.
    await conn.query(`SELECT id FROM cases WHERE id = ? FOR UPDATE`, [caseId]);

    const [existingRows] = await conn.query(
      `SELECT s.id AS sale_id, s.policy_number, s.certificate_number,
              i.id AS invoice_id, i.invoice_number, c.id AS certificate_id
         FROM sales s
         LEFT JOIN invoices i     ON i.sale_id = s.id
         LEFT JOIN certificates c ON c.sale_id = s.id
        WHERE s.case_id = ? AND s.deleted_at IS NULL
        LIMIT 1`,
      [caseId]
    );
    if (existingRows[0]) {
      const row = existingRows[0];
      await conn.commit();
      return {
        created: false,
        saleId: row.sale_id,
        policyNumber: row.policy_number,
        certificateNumber: row.certificate_number,
        invoiceNumber: row.invoice_number,
        invoiceId: row.invoice_id,
        certificateId: row.certificate_id,
      };
    }

    const numbers = await allocateSaleNumbers(conn, formats);

    const saleId = await createSale(
      {
        case_id: caseId,
        policy_number: numbers.policyNumber,
        certificate_number: numbers.certificateNumber,
        premium_amount: pricing.premium,
        tax: pricing.tax || 0,
        total: pricing.total,
        currency: pricing.currency || "XOF",
        plan_price: pricing.planPrice || 0,
        // Coverage limits live in guarantees_details only — never billed as a sum.
        guarantees_total: 0,
        guarantees_details: pricing.guaranteesDetails ?? null,
      },
      conn
    );

    // Money already in hand: record it on the sale rather than leaving the
    // policy Unpaid and relying on someone to flip it by hand later.
    if (paid) {
      await conn.execute(
        `UPDATE sales
            SET payment_status = 'Paid',
                received_amount = ?,
                paid_at = NOW(),
                payment_method = ?,
                payment_reference = ?
          WHERE id = ?`,
        [paid.amount ?? pricing.total, paid.method || null, paid.reference || null, saleId]
      );
    }

    const invoiceId = await createInvoice(
      {
        sale_id: saleId,
        invoice_number: numbers.invoiceNumber,
        subtotal: pricing.premium,
        tax: pricing.tax || 0,
        total: pricing.total,
        payment_status: paid ? "Paid" : "Unpaid",
      },
      conn
    );

    const snapshot = buildSnapshot({ caseRow, pricing, numbers, paid });
    const certificateId = await createCertificate(
      {
        sale_id: saleId,
        certificate_number: numbers.certificateNumber,
        public_token: generatePublicToken(),
        coverage_summary: caseRow.coverage || "",
      },
      conn
    );

    await conn.execute(`UPDATE certificates SET issued_snapshot = ? WHERE id = ?`, [
      JSON.stringify(snapshot),
      certificateId,
    ]);

    await conn.commit();

    return {
      created: true,
      saleId,
      invoiceId,
      certificateId,
      policyNumber: numbers.policyNumber,
      certificateNumber: numbers.certificateNumber,
      invoiceNumber: numbers.invoiceNumber,
      snapshot,
    };
  } catch (err) {
    try { await conn.rollback(); } catch { /* released below */ }
    throw err;
  } finally {
    conn.release();
  }
}

/**
 * Re-freeze the snapshot after a DELIBERATE correction to the policy.
 *
 * The snapshot exists so that editing the catalogue cannot silently rewrite a
 * document a customer is carrying. It was never meant to stop an operator
 * correcting the policy itself — and that is exactly what it did: an adviser
 * fixed a destination, saw the change in the case screen, downloaded the
 * certificate and got the old destination back, with no indication why.
 *
 * So the rule is: the catalogue cannot move the snapshot, an audited policy edit
 * can. What does NOT change is the policy's identity — its numbers and the date
 * it was issued. Those are what make it the same policy rather than a new one.
 *
 * Every revision is kept inside the snapshot, so "what did this certificate say
 * before?" has an answer.
 */
export async function refreshIssuedSnapshot({ saleId, caseRow, pricing, reason = "policy_edit", byUserId = null }) {
  const pool = getPool();
  const [rows] = await pool.query(
    `SELECT c.id AS certificate_id, c.certificate_number, c.issued_snapshot,
            s.policy_number, i.invoice_number
       FROM certificates c
       JOIN sales s      ON s.id = c.sale_id
       LEFT JOIN invoices i ON i.sale_id = c.sale_id
      WHERE c.sale_id = ?
      LIMIT 1`,
    [saleId]
  );
  const row = rows[0];
  if (!row) return { ok: false, reason: "no_certificate" };

  let previous = row.issued_snapshot;
  if (typeof previous === "string") {
    try { previous = JSON.parse(previous); } catch { previous = null; }
  }

  // A policy with no snapshot predates m3_07 and is still rendered live, so
  // writing one now would FREEZE it for the first time — a behaviour change
  // nobody asked for, triggered by an unrelated edit.
  if (!previous) return { ok: false, reason: "no_snapshot" };

  const numbers = {
    policyNumber: row.policy_number,
    certificateNumber: row.certificate_number,
    invoiceNumber: row.invoice_number || previous.invoice_number || null,
  };

  const next = buildSnapshot({ caseRow, pricing, numbers, paid: null });

  // Identity and money that did not move carry over unchanged.
  next.issued_at = previous.issued_at || next.issued_at;
  next.payment = previous.payment ?? null;
  next.revised_at = new Date().toISOString();
  next.revisions = [
    ...(Array.isArray(previous.revisions) ? previous.revisions : []),
    {
      at: next.revised_at,
      by: byUserId,
      reason,
      replaced: {
        traveller: previous.traveller ?? null,
        trip: previous.trip ?? null,
        plan: previous.plan ?? null,
        pricing: previous.pricing ?? null,
      },
    },
  ].slice(-10);

  await pool.execute(`UPDATE certificates SET issued_snapshot = ? WHERE id = ?`, [
    JSON.stringify(next),
    row.certificate_id,
  ]);

  return { ok: true, certificateId: row.certificate_id, certificateNumber: row.certificate_number, snapshot: next };
}

/** The frozen snapshot for a sale, or null for a policy issued before m3_07. */
export async function getIssuedSnapshot(saleId) {
  const [rows] = await getPool().query(
    `SELECT issued_snapshot FROM certificates WHERE sale_id = ? LIMIT 1`,
    [saleId]
  );
  const raw = rows[0]?.issued_snapshot;
  if (!raw) return null;
  if (typeof raw === "object") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export const __testables = { buildSnapshot };
