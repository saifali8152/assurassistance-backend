import PDFDocument from "pdfkit";
import fs from "fs";
import path from "path";

const ensureDir = (dir) => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
};

export const generateInvoicePDF = async ({ invoiceNumber, sale, traveller, plan, subtotal, tax, total }) => {
  ensureDir(path.join(process.cwd(), "uploads", "invoices"));

  const fileName = `${invoiceNumber}.pdf`;
  const filePath = path.join(process.cwd(), "uploads", "invoices", fileName);
  const doc = new PDFDocument({ size: "A4", margin: 50 });

  return new Promise((resolve, reject) => {
    const stream = fs.createWriteStream(filePath);
    doc.pipe(stream);

    // COLORS
    const primaryColor = "#1c398e";
    const secondaryColor = "#0f172b";
    const white = "#FFFFFF";

    // HEADER BAR
    doc.rect(0, 0, doc.page.width, 70).fill(primaryColor);
    doc.fillColor(white).fontSize(20).text("INVOICE", 50, 25);

    // LOGO (if exists)
    const logoPath = path.join(process.cwd(), "public", "logo.png");
    if (fs.existsSync(logoPath)) {
      doc.image(logoPath, doc.page.width - 150, 15, { width: 100 });
    }

    doc.moveDown(4);
    doc.fillColor("black").fontSize(10);

    // Invoice Meta Info
    doc.text(`Invoice No: ${invoiceNumber}`);
    doc.text(`Policy No: ${sale.policy_number || ""}`);
    doc.text(`Issue Date: ${new Date().toLocaleDateString()}`);
    doc.moveDown();

    // Bill To Section
    doc.fontSize(12).fillColor(secondaryColor).text("Bill To:");
    doc.fontSize(10).fillColor("black").text(`${traveller.full_name}`);
    if (traveller.email) doc.text(traveller.email);
    if (traveller.phone) doc.text(traveller.phone);
    doc.moveDown(2);

    // Table Header
    const tableTop = doc.y;
    doc.rect(50, tableTop, 500, 20).fill(primaryColor);
    doc.fillColor(white).text("Description", 60, tableTop + 5);
    doc.text("Amount", 450, tableTop + 5, { align: "right" });

    // Table Rows
    let y = tableTop + 25;
    const row = (desc, amount) => {
      doc.fillColor("black").rect(50, y, 500, 20).stroke();
      doc.text(desc, 60, y + 5);
      doc.text(amount.toFixed(2), 450, y + 5, { align: "right" });
      y += 20;
    };

    row(plan?.name || "Insurance Plan", subtotal);
    row("Tax", tax);
    row("Total", total);

    // Footer
    doc.moveDown(4);
    doc.fontSize(9).fillColor("gray")
      .text("Payment status will be updated in the admin portal.", { align: "center" });

    doc.moveDown(2);
    doc.fontSize(8).fillColor("gray")
      .text("AssurAssistance — Address — Contact Info", { align: "center" });

    doc.end();

    stream.on("finish", () => resolve(`/uploads/invoices/${fileName}`));
    stream.on("error", (err) => reject(err));
  });
};

export const generateCertificatePDF = async ({ certificateNumber, sale, traveller, plan, productType }) => {
  ensureDir(path.join(process.cwd(), "uploads", "certificates"));

  const fileName = `${certificateNumber}.pdf`;
  const filePath = path.join(process.cwd(), "uploads", "certificates", fileName);
  const doc = new PDFDocument({ size: "A4", margin: 50 });

  return new Promise((resolve, reject) => {
    const stream = fs.createWriteStream(filePath);
    doc.pipe(stream);

    // COLORS
    const primaryColor = "#1c398e";
    const secondaryColor = "#0f172b";
    const white = "#FFFFFF";

    // HEADER BAR
    doc.rect(0, 0, doc.page.width, 70).fill(primaryColor);
    doc.fillColor(white).fontSize(20).text("INSURANCE CERTIFICATE", 50, 25);

    // LOGO
    const logoPath = path.join(process.cwd(), "public", "logo.png");
    if (fs.existsSync(logoPath)) {
      doc.image(logoPath, doc.page.width - 150, 15, { width: 100 });
    }

    doc.moveDown(4);
    doc.fillColor("black").fontSize(10);

    // Product-specific title
    let title = "Insurance Certificate";
    if (productType === "Travel") title = "Travel Insurance Certificate";
    if (productType === "Bank") title = "Bank Guarantee Certificate";
    if (productType === "Health Evacuation") title = "Health Evacuation Certificate";
    if (productType === "Travel Inbound") title = "Inbound Travel Insurance Certificate";

    doc.fontSize(16).fillColor(secondaryColor).text(title, { align: "center" });
    doc.moveDown();

    // Meta Information
    doc.fontSize(10).fillColor("black");
    doc.text(`Certificate No: ${certificateNumber}`);
    doc.text(`Policy No: ${sale.policy_number || ""}`);
    doc.text(`Issue Date: ${new Date().toLocaleDateString()}`);
    doc.moveDown();

    // Traveller Details
    doc.fontSize(12).fillColor(secondaryColor).text("Insured Person:");
    doc.fontSize(10).fillColor("black");
    doc.text(`${traveller.full_name}`);
    if (traveller.passport_or_id) doc.text(`Passport/ID: ${traveller.passport_or_id}`);
    if (traveller.phone) doc.text(`Phone: ${traveller.phone}`);
    if (traveller.email) doc.text(`Email: ${traveller.email}`);
    doc.moveDown(2);

    // Coverage Summary Section
    doc.fontSize(12).fillColor(secondaryColor).text("Coverage Summary:");
    doc.moveDown(0.5);

    // Table for coverage
    const coverageText = plan?.coverage || "Coverage details as per policy terms";
    const textWidth = doc.widthOfString(coverageText);
    const rowHeight = 40;
    doc.rect(50, doc.y, 500, rowHeight).stroke();
    doc.fontSize(10).fillColor("black").text(coverageText, 60, doc.y + 10);

    doc.moveDown(4);

    // Footer Info
    doc.fontSize(9).fillColor("gray")
      .text("This certificate is issued electronically and is valid without signature.", { align: "center" });

    doc.moveDown(2);
    doc.fontSize(8).fillColor("gray")
      .text("AssurAssistance — Islamabad, Pakistan — 0123-45678", { align: "center" });

    doc.end();

    stream.on("finish", () => resolve(`/uploads/certificates/${fileName}`));
    stream.on("error", (err) => reject(err));
  });
};
