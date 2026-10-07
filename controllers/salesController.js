import { createSale, getAllSales, getSaleById, updatePaymentStatus } from "../models/salesModel.js";
import { getCaseDetailsById } from "../models/caseModel.js";
import { logActivity } from "../models/activityModel.js";  // <-- Add this
import getPool from "../utils/db.js";
import { getAgeFromDateString, getAgePremiumMultiplier, AGE_EXEMPTION_MESSAGE } from "../utils/travelPricing.js";
import { issuePolicy } from "../models/policyIssuance.js";

/** The only values sales.payment_status may hold. Mirrors the column ENUM. */
export const PAYMENT_STATUSES = ["Unpaid", "Paid", "Partial"];

/**
 * Create the sale, its invoice and its certificate — exactly once per case.
 *
 * This used to be three separate pool writes with numbers minted from
 * Date.now() and no check for an existing sale, so a partner retrying a
 * timed-out POST issued a second policy with its own certificate and invoice,
 * and two requests in the same millisecond collided on the UNIQUE policy number
 * and surfaced as an opaque 500 with the sale possibly already written.
 *
 * Three things changed:
 *   1. One transaction on one connection, so a failure half way leaves nothing.
 *   2. SELECT ... FOR UPDATE on the case, so two confirmations of the same case
 *      queue instead of racing; the UNIQUE index added by m3_03 is the backstop
 *      for the case where they arrive on different app servers.
 *   3. Numbers come from an allocated sequence (utils/documentNumbers.js).
 *
 * A retry returns the ORIGINAL sale rather than an error. That is what a client
 * whose request timed out actually needs, and it makes the endpoint safe to
 * call again from a payment callback.
 */
/**
 * Create the sale, its invoice and its certificate — exactly once per case.
 *
 * The transaction, the row lock, the numbering and the snapshot all live in
 * models/policyIssuance.js, which the payment callback and the case-confirm
 * endpoint also call. Three copies of this logic would drift; one cannot.
 *
 * A retry returns the ORIGINAL sale rather than an error. That is what a client
 * whose request timed out actually needs, and it is what makes the endpoint
 * safe to call again from a payment callback.
 */
export const createSaleController = async (req, res) => {
  try {
    const {
      case_id,
      premium_amount,
      tax = 0,
      total,
      currency = 'XOF',
      plan_price = 0,
      guarantees_details = null
    } = req.body;
    const created_by = req.user.id;

    if (!case_id || !premium_amount || !total) {
      return res.status(400).json({ message: "Missing required fields" });
    }

    const caseRow = await getCaseDetailsById(case_id);
    if (!caseRow) {
      return res.status(404).json({ message: "Case not found" });
    }
    if (["Travel", "Travel Inbound", "Road travel"].includes(caseRow.product_type)) {
      const age = getAgeFromDateString(caseRow.date_of_birth);
      if (!getAgePremiumMultiplier(age).eligible) {
        return res.status(400).json({ message: AGE_EXEMPTION_MESSAGE });
      }
    }

    const issued = await issuePolicy({
      caseId: case_id,
      caseRow,
      pricing: {
        premium: premium_amount,
        tax: tax || 0,
        total,
        currency: currency || 'XOF',
        planPrice: plan_price || 0,
        guaranteesDetails: guarantees_details ?? null,
      },
    });

    if (issued.created) {
      try {
        await logActivity(
          created_by,
          `Created Sale - ID:${issued.saleId}, Invoice:${issued.invoiceNumber}, Certificate:${issued.certificateNumber}`
        );
      } catch (logErr) {
        console.error("Activity log failed:", logErr.message);
      }
    }

    res.status(201).json({
      message: issued.created ? "Sale created successfully" : "Sale already exists for this case",
      duplicate: !issued.created,
      saleId: issued.saleId,
      policyNumber: issued.policyNumber,
      certificateNumber: issued.certificateNumber,
      invoice: { id: issued.invoiceId, invoiceNumber: issued.invoiceNumber },
      certificate: { id: issued.certificateId, certificateNumber: issued.certificateNumber }
    });
  } catch (err) {
    console.error("Error creating sale:", err);
    res.status(500).json({ message: "Server error" });
  }
};



// Get all Sales
export const getAllSalesController = async (req, res) => {
  try {
    const sales = await getAllSales();
    res.json(sales);
  } catch (err) {
    console.error("Error fetching sales:", err);
    res.status(500).json({ message: "Server error" });
  }
};

// Get Sale by ID
export const getSaleByIdController = async (req, res) => {
  try {
    const saleId = req.params.id;
    const sale = await getSaleById(saleId);

    if (!sale) {
      return res.status(404).json({ message: "Sale not found" });
    }

    res.json(sale);
  } catch (err) {
    console.error("Error fetching sale:", err);
    res.status(500).json({ message: "Server error" });
  }
};

export const updatePaymentStatusController = async (req, res) => {
  const { id } = req.params;
  const { payment_status, payment_notes, received_amount } = req.body;
  const userRole = req.user.role;

  // Only admin can update payment status
  if (userRole !== "admin") {
    return res.status(403).json({ error: "Only administrators can update payment status" });
  }

  // The submitted value used to go straight into the UPDATE, so whatever a
  // caller sent landed in the column and MySQL's mode was the only guard.
  if (!PAYMENT_STATUSES.includes(payment_status)) {
    return res.status(400).json({
      error: `payment_status must be one of: ${PAYMENT_STATUSES.join(", ")}`,
      code: "invalid_payment_status",
    });
  }

  try {
    const pool = getPool();
    const {
      MAX_PAYMENT_REVERSES,
    } = await import("../utils/policyLifecycle.js");

    const [existingSale] = await pool.execute(
      `SELECT id, payment_status, payment_reverse_count, deleted_at, received_amount
       FROM sales WHERE id = ?`,
      [id]
    );

    if (existingSale.length === 0) {
      return res.status(404).json({ error: "Sale not found" });
    }

    const sale = existingSale[0];
    if (sale.deleted_at != null) {
      return res.status(400).json({
        error: "Cannot update payment status on a deleted policy",
        code: "policy_deleted",
      });
    }

    const currentStatus = sale.payment_status;
    const reverseCount = Number(sale.payment_reverse_count) || 0;
    const isReverse = currentStatus === "Paid" && payment_status === "Unpaid";

    if (isReverse) {
      if (reverseCount >= MAX_PAYMENT_REVERSES) {
        return res.status(400).json({
          error: `Paid status can only be reversed at most ${MAX_PAYMENT_REVERSES} times per policy`,
          code: "payment_reverse_limit",
          payment_reverse_count: reverseCount,
          payment_reverses_remaining: 0,
        });
      }
    }

    const nextReceived =
      payment_status === "Unpaid" ? 0 : received_amount != null ? received_amount : sale.received_amount || 0;
    const nextReverseCount = isReverse ? reverseCount + 1 : reverseCount;

    await pool.execute(
      `UPDATE sales
       SET payment_status = ?, payment_notes = ?, received_amount = ?, payment_reverse_count = ?
       WHERE id = ?`,
      [payment_status, payment_notes || "", nextReceived || 0, nextReverseCount, id]
    );

    try {
      if (isReverse) {
        await logActivity(
          req.user.id,
          `payment_reverse:${id}:${nextReverseCount}/${MAX_PAYMENT_REVERSES}`.slice(0, 100)
        );
      } else {
        await logActivity(
          req.user.id,
          `payment_status:${id}:${currentStatus}->${payment_status}`.slice(0, 100)
        );
      }
    } catch (logErr) {
      console.error("Failed to log payment status change:", logErr);
    }

    res.json({
      message: isReverse
        ? "Payment status reversed to Unpaid"
        : "Payment details updated successfully",
      data: {
        sale_id: Number(id),
        payment_status,
        payment_reverse_count: nextReverseCount,
        payment_reverses_remaining: Math.max(0, MAX_PAYMENT_REVERSES - nextReverseCount),
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to update payment details" });
  }
};

/**
 * Admin soft-delete: policy stays visible with premium/commission displayed as 0.
 * Requires a canonical deletion reason.
 */
export const softDeleteSaleController = async (req, res) => {
  const { id } = req.params;
  const { reason } = req.body || {};

  if (req.user.role !== "admin") {
    return res.status(403).json({
      success: false,
      message: "Only administrators can delete a policy",
    });
  }

  try {
    const {
      isValidDeletionReason,
      POLICY_DELETION_REASONS,
    } = await import("../utils/policyLifecycle.js");

    if (!isValidDeletionReason(reason)) {
      return res.status(400).json({
        success: false,
        message: "A valid deletion reason is required",
        allowed_reasons: POLICY_DELETION_REASONS,
      });
    }

    const pool = getPool();
    const [rows] = await pool.execute(
      `SELECT id, deleted_at, case_id FROM sales WHERE id = ?`,
      [id]
    );
    if (!rows.length) {
      return res.status(404).json({ success: false, message: "Sale not found" });
    }
    if (rows[0].deleted_at != null) {
      return res.status(400).json({
        success: false,
        message: "Policy is already deleted",
        code: "already_deleted",
      });
    }

    const cleanReason = String(reason).trim();
    await pool.execute(
      `UPDATE sales
       SET deleted_at = NOW(),
           deleted_by_user_id = ?,
           deletion_reason = ?,
           received_amount = 0
       WHERE id = ?`,
      [req.user.id, cleanReason, id]
    );

    try {
      const reasonKey = cleanReason.replace(/\s+/g, "_").slice(0, 40);
      await logActivity(
        req.user.id,
        `policy_soft_delete:${id}:${reasonKey}`.slice(0, 100)
      );
    } catch (logErr) {
      console.error("Failed to log policy soft-delete:", logErr);
    }

    res.json({
      success: true,
      message: "Policy deleted. It remains visible with premium and commission set to 0.",
      data: {
        sale_id: Number(id),
        case_id: rows[0].case_id,
        deletion_reason: cleanReason,
        is_deleted: true,
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Server error" });
  }
};

/** Public list of allowed soft-delete reasons (admin UI). */
export const listPolicyDeletionReasonsController = async (req, res) => {
  if (req.user.role !== "admin") {
    return res.status(403).json({ success: false, message: "Admin only" });
  }
  const { POLICY_DELETION_REASONS } = await import("../utils/policyLifecycle.js");
  res.json({ success: true, data: POLICY_DELETION_REASONS });
};
