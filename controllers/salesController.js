import { v4 as uuidv4 } from "uuid";
import { createSale, getAllSales, getSaleById, updatePaymentStatus } from "../models/salesModel.js";
import { createInvoice } from "../models/invoiceModel.js";
import { createCertificate } from "../models/certificateModel.js";
import { getCaseDetailsById } from "../models/caseModel.js";
import { logActivity } from "../models/activityModel.js";  // <-- Add this
import getPool from "../utils/db.js";

export const createSaleController = async (req, res) => {
  try {
    const { 
      case_id, 
      premium_amount, 
      tax = 0, 
      total,
      currency = 'XOF',
      plan_price = 0,
      guarantees_total = 0,
      guarantees_details = null
    } = req.body;
    const created_by = req.user.id; // <-- We'll log the user creating the sale

    if (!case_id || !premium_amount || !total) {
      return res.status(400).json({ message: "Missing required fields" });
    }

    // 1. Generate numbers
    const policyNumber = `POL-${Date.now()}`;
    const certificateNumber = `CERT-${uuidv4().slice(0, 8).toUpperCase()}`;
    const invoiceNumber = `INV-${Date.now()}`;

    // 2. Save Sale
    const saleId = await createSale({
      case_id,
      policy_number: policyNumber,
      certificate_number: certificateNumber,
      premium_amount,
      tax: tax || 0,
      total,
      currency: currency || 'XOF',
      plan_price: plan_price || 0,
      guarantees_total: guarantees_total || 0,
      guarantees_details: (guarantees_details !== null && guarantees_details !== undefined) ? guarantees_details : null
    });

    // 3. Get case + traveller + plan details
    const caseDetails = await getCaseDetailsById(case_id);
    const traveller = {
      full_name: caseDetails.full_name,
      phone: caseDetails.phone,
      email: caseDetails.email,
      passport_or_id: caseDetails.passport_or_id,
      address: caseDetails.address
    };
    const plan = {
      id: caseDetails.plan_id,
      name: caseDetails.plan_name,
      product_type: caseDetails.product_type,
      coverage: caseDetails.coverage,
      flat_price: caseDetails.flat_price
    };

    // 4. Create invoice record
    const invoiceId = await createInvoice({
      sale_id: saleId,
      invoice_number: invoiceNumber,
      subtotal: Number(premium_amount),
      tax: Number(tax),
      total: Number(total),
      payment_status: 'Unpaid'
    });

    // 5. Create certificate record
    const certId = await createCertificate({
      sale_id: saleId,
      certificate_number: certificateNumber,
      coverage_summary: plan.coverage || ''
    });

    // Note: PDFs are now generated on-demand, not saved to storage

    // 8. Log Activity (non-blocking)
    try {
      await logActivity(created_by, `Created Sale - ID:${saleId}, Invoice:${invoiceNumber}, Certificate:${certificateNumber}`);
    } catch (logErr) {
      console.error("Activity log failed:", logErr.message);
    }

    // 6. Respond to frontend
    res.status(201).json({
      message: "Sale created successfully",
      saleId,
      policyNumber,
      certificateNumber,
      invoice: { 
        id: invoiceId, 
        invoiceNumber
      },
      certificate: { 
        id: certId, 
        certificateNumber
      }
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
  if (userRole !== 'admin') {
    return res.status(403).json({ error: "Only administrators can update payment status" });
  }

  try {
    const pool = getPool();
    
    // First, check if the sale exists and get current payment status
    const [existingSale] = await pool.execute(
      `SELECT payment_status FROM sales WHERE id = ?`,
      [id]
    );
    
    if (existingSale.length === 0) {
      return res.status(404).json({ error: "Sale not found" });
    }
    
    const currentStatus = existingSale[0].payment_status;
    
    // Prevent changing from Paid back to Unpaid
    if (currentStatus === 'Paid' && payment_status === 'Unpaid') {
      return res.status(400).json({ error: "Cannot change payment status from Paid to Unpaid" });
    }
    
    await pool.execute(
      `UPDATE sales 
       SET payment_status = ?, payment_notes = ?, received_amount = ?
       WHERE id = ?`,
      [payment_status, payment_notes || "", received_amount || 0, id]
    );
    
    res.json({ message: "Payment details updated successfully" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to update payment details" });
  }
};
