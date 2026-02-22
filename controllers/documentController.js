import { getInvoiceBySaleId } from "../models/invoiceModel.js";
import { getCertificateBySaleId } from "../models/certificateModel.js";
import { generateInvoicePDF, generateCertificatePDF } from "../utils/pdfGenerator.js";
import { getCaseDetailsById } from "../models/caseModel.js";
import { getSaleById } from "../models/salesModel.js";

export const downloadInvoice = async (req, res) => {
  try {
    const saleId = req.params.id;
    const invoice = await getInvoiceBySaleId(saleId);
    if (!invoice) {
      return res.status(404).json({ message: "Invoice not found" });
    }

    const saleDetails = await getSaleById(invoice.sale_id);
    if (!saleDetails) {
      return res.status(404).json({ message: "Sale not found" });
    }

    const caseDetails = await getCaseDetailsById(saleDetails.case_id);
    if (!caseDetails) {
      return res.status(404).json({ message: "Case not found" });
    }

    // Prepare data for PDF generation
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

    const sale = saleDetails;

    // Generate PDF buffer (without saving to file)
    const pdfBuffer = await generateInvoicePDF({
      invoiceNumber: invoice.invoice_number,
      sale,
      traveller,
      plan,
      subtotal: invoice.subtotal,
      tax: invoice.tax,
      total: invoice.total
    }, true); // true = return buffer instead of saving file

    // Set headers for PDF download
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="invoice-${invoice.invoice_number}.pdf"`);
    res.setHeader('Content-Length', pdfBuffer.length);

    // Send PDF buffer
    res.send(pdfBuffer);
  } catch (err) {
    console.error("Error downloading invoice:", err);
    res.status(500).json({ message: "Server error" });
  }
};

export const downloadCertificate = async (req, res) => {
  try {
    const saleId = req.params.id;
    const cert = await getCertificateBySaleId(saleId);
    if (!cert) {
      return res.status(404).json({ message: "Certificate not found" });
    }

    const saleDetails = await getSaleById(cert.sale_id);
    if (!saleDetails) {
      return res.status(404).json({ message: "Sale not found" });
    }

    const caseDetails = await getCaseDetailsById(saleDetails.case_id);
      if (!caseDetails) {
      return res.status(404).json({ message: "Case not found" });
    }

    // Prepare data for PDF generation
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

    const sale = saleDetails;

    // Generate PDF buffer (without saving to file)
    const pdfBuffer = await generateCertificatePDF({
      certificateNumber: cert.certificate_number,
      sale,
      traveller,
      plan,
      productType: plan.product_type
    }, true); // true = return buffer instead of saving file

    // Set headers for PDF download
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="certificate-${cert.certificate_number}.pdf"`);
    res.setHeader('Content-Length', pdfBuffer.length);

    // Send PDF buffer
    res.send(pdfBuffer);
  } catch (err) {
    console.error("Error downloading certificate:", err);
    res.status(500).json({ message: "Server error" });
  }
};
