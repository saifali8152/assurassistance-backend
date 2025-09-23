// src/utils/pdfGenerator.js
import PDFDocument from "pdfkit";
import fs from "fs";
import path from "path";

const ensureDir = (dir) => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
};

export const generateInvoicePDF = async ({ invoiceNumber, sale, traveller, plan, subtotal, tax, total }) => {
  ensureDir(path.join(process.cwd(), 'uploads', 'invoices'));

  const fileName = `${invoiceNumber}.pdf`;
  const filePath = path.join(process.cwd(), 'uploads', 'invoices', fileName);
  const doc = new PDFDocument({ size: 'A4', margin: 50 });

  return new Promise((resolve, reject) => {
    const stream = fs.createWriteStream(filePath);
    doc.pipe(stream);

    // Header
    doc.fontSize(20).text("INVOICE", { align: 'center' });
    doc.moveDown();
    doc.fontSize(10);
    // Company info (replace with real)
    doc.text("Issuer: AssurAssistance", { continued: true }).text(`\nIssue Date: ${new Date().toLocaleDateString()}`, { align: "right" });
    doc.moveDown();

    // Invoice meta
    doc.text(`Invoice No: ${invoiceNumber}`);
    doc.text(`Sale/Policy No: ${sale.policy_number || ''}`);
    doc.moveDown();

    // Bill to
    doc.fontSize(12).text("Bill To:");
    doc.fontSize(10).text(`${traveller.full_name}`);
    if (traveller.email) doc.text(traveller.email);
    if (traveller.phone) doc.text(traveller.phone);
    doc.moveDown();

    // Line items
    doc.text("Description", { continued: true }).text("Amount", { align: "right" });
    doc.moveDown(0.3);
    doc.text(`${plan?.name || 'Insurance Plan'}`, { continued: true }).text(`${subtotal.toFixed(2)}`, { align: "right" });
    doc.moveDown();
    doc.text("Tax", { continued: true }).text(`${tax.toFixed(2)}`, { align: "right" });
    doc.moveDown();
    doc.text("Total", { continued: true }).text(`${total.toFixed(2)}`, { align: "right" });

    doc.moveDown(2);
    doc.fontSize(9).text("Payment Status will be updated in the admin portal. This is a system generated invoice.", { align: "center" });

    // Footer
    doc.moveDown(2);
    doc.fontSize(8).text("AssurAssistance - Address - Contact", { align: "center" });

    doc.end();

    stream.on('finish', () => resolve(`/uploads/invoices/${fileName}`));
    stream.on('error', (err) => reject(err));
  });
};

export const generateCertificatePDF = async ({ certificateNumber, sale, traveller, plan, productType }) => {
  ensureDir(path.join(process.cwd(), 'uploads', 'certificates'));

  const fileName = `${certificateNumber}.pdf`;
  const filePath = path.join(process.cwd(), 'uploads', 'certificates', fileName);
  const doc = new PDFDocument({ size: 'A4', margin: 50 });

  return new Promise((resolve, reject) => {
    const stream = fs.createWriteStream(filePath);
    doc.pipe(stream);

    // Header — different title depending on productType
    let title = "Insurance Certificate";
    if (productType === "Travel") title = "Travel Insurance Certificate";
    if (productType === "Bank") title = "Bank Guarantee Certificate";
    if (productType === "Health Evacuation") title = "Health Evacuation Certificate";
    if (productType === "Travel Inbound") title = "Inbound Travel Insurance Certificate";

    doc.fontSize(20).text(title, { align: 'center' });
    doc.moveDown();

    // Meta
    doc.fontSize(10).text(`Certificate No: ${certificateNumber}`);
    doc.text(`Policy No: ${sale.policy_number || ''}`);
    doc.text(`Issue Date: ${new Date().toLocaleDateString()}`);
    doc.moveDown();

    // Traveller & coverage
    doc.fontSize(12).text("Insured");
    doc.fontSize(10).text(`${traveller.full_name} (Passport/ID: ${traveller.passport_or_id || ''})`);
    doc.text(`Contact: ${traveller.phone || ''} / ${traveller.email || ''}`);
    doc.moveDown();

    doc.fontSize(12).text("Coverage Summary");
    doc.fontSize(10).text(plan?.coverage || 'Coverage details as per policy', { align: 'left' });
    doc.moveDown();

    // Trip/duration if available
    if (sale && sale.confirmed_at) {
      // sale may not have dates here — use case data if needed
    }
    doc.moveDown();

    doc.fontSize(9).text("Terms & Conditions apply. See full policy wording.", { align: "left" });

    doc.moveDown(2);
    doc.fontSize(8).text("Issuer: AssurAssistance — This certificate is issued electronically.", { align: "center" });

    doc.end();

    stream.on('finish', () => resolve(`/uploads/certificates/${fileName}`));
    stream.on('error', (err) => reject(err));
  });
};
