import { v4 as uuidv4 } from "uuid";
import { createSale, getAllSales, getSaleById } from "../models/salesModel.js";
import { createInvoice, updateInvoicePdf } from "../models/invoiceModel.js";
import { createCertificate, updateCertificatePdf } from "../models/certificateModel.js";
import { getCaseDetailsById } from "../models/caseModel.js";
import { generateInvoicePDF, generateCertificatePDF } from "../utils/pdfGenerator.js";

export const createSaleController = async (req, res) => {
  try {
    const { case_id, premium_amount, tax = 0, total } = req.body;

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
      total
    });

    // 3. Get case + traveller + plan details to fill PDFs
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

    // 5. Generate Invoice PDF and update invoice record
    const invoicePdfPath = await generateInvoicePDF({
      invoiceNumber,
      sale: { id: saleId, policy_number: policyNumber },
      traveller,
      plan,
      subtotal: Number(premium_amount),
      tax: Number(tax),
      total: Number(total)
    });
    await updateInvoicePdf(invoiceId, invoicePdfPath);

    // 6. Create certificate record
    const certId = await createCertificate({
      sale_id: saleId,
      certificate_number: certificateNumber,
      coverage_summary: plan.coverage || ''
    });

    // 7. Generate Certificate PDF and update certificate record
    const certificatePdfPath = await generateCertificatePDF({
      certificateNumber,
      sale: { id: saleId, policy_number: policyNumber },
      traveller,
      plan,
      productType: plan.product_type
    });
    await updateCertificatePdf(certId, certificatePdfPath);

    // 8. Respond with details and paths (frontend will use returned file urls)
const BASE_URL = process.env.VITE_API_URL || "http://localhost:5000";

res.status(201).json({
  message: "Sale created and documents generated",
  saleId,
  policyNumber,
  certificateNumber,
  invoice: { 
    id: invoiceId, 
    invoiceNumber, 
    pdfUrl: `${BASE_URL}/${invoicePdfPath}` 
  },
  certificate: { 
    id: certId, 
    certificateNumber, 
    pdfUrl: `${BASE_URL}/${certificatePdfPath}` 
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
