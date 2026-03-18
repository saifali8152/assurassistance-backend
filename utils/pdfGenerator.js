import PDFDocument from "pdfkit";
import fs from "fs";
import path from "path";

const ensureDir = (dir) => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
};

export const generateInvoicePDF = async ({ invoiceNumber, sale, traveller, plan, subtotal, tax, total, countryOfResidence }, returnBuffer = false) => {
  const doc = new PDFDocument({ size: "A4", margin: 50 });

  return new Promise((resolve, reject) => {
    let stream;
    let chunks = [];
    
    if (returnBuffer) {
      // For buffer mode - collect chunks
      doc.on('data', (chunk) => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);
    } else {
      // For file mode - save to storage
      ensureDir(path.join(process.cwd(), "uploads", "invoices"));
      const fileName = `${invoiceNumber}.pdf`;
      const filePath = path.join(process.cwd(), "uploads", "invoices", fileName);
      stream = fs.createWriteStream(filePath);
      doc.pipe(stream);
    }
    // COLORS
    const primaryColor = "#1c398e";
    const secondaryColor = "#0f172b";
    const white = "#FFFFFF";
    const lightGray = "#f8f9fa";
    const darkGray = "#666666";

    // HEADER SECTION
    doc.rect(0, 0, doc.page.width, 80).fill(white);
    
    // LOGO (if exists)
    const logoPath = path.join(process.cwd(), "public", "logo.png");
    if (fs.existsSync(logoPath)) {
      doc.image(logoPath, 50, 20, { width: 60, height: 40 });
    } else {
      // Logo placeholder
      doc.rect(50, 20, 60, 40).fill(lightGray).stroke('#cccccc');
      doc.fillColor(darkGray).fontSize(10).text("LOGO", 65, 35);
    }

    // INVOICE title
    doc.fillColor(primaryColor).fontSize(28).font('Helvetica-Bold')
       .text("INVOICE", doc.page.width - 200, 30);

    // Horizontal line
    doc.moveTo(50, 85).lineTo(doc.page.width - 50, 85).stroke('#cccccc');

    doc.moveDown(3);

    // INVOICE DETAILS SECTION (Top Right)
    const invoiceDetailsY = 110;
    doc.fillColor('black').fontSize(10).font('Helvetica');
    doc.text(`Invoice No.:`, doc.page.width - 250, invoiceDetailsY);
    doc.text(`${invoiceNumber}`, doc.page.width - 150, invoiceDetailsY);
    
    doc.text(`Issue Date:`, doc.page.width - 250, invoiceDetailsY + 15);
    doc.text(`${new Date().toLocaleDateString()}`, doc.page.width - 150, invoiceDetailsY + 15);

    // BILL TO Section
    doc.fillColor(secondaryColor).fontSize(12).font('Helvetica-Bold')
       .text("BILL TO", 50, invoiceDetailsY + 50);
    
    doc.fillColor('black').fontSize(10).font('Helvetica');
    doc.text(`Name: ${traveller.full_name}`, 50, invoiceDetailsY + 75);
    
    if (traveller.passport_or_id) {
      doc.text(`Passport/ID: ${traveller.passport_or_id}`, 50, invoiceDetailsY + 90);
    }
    
    if (traveller.phone) {
      doc.text(`Contact: ${traveller.phone}`, doc.page.width - 250, invoiceDetailsY + 90);
    }

    // POLICY INFORMATION Section
    const policyY = invoiceDetailsY + 130;
    doc.fillColor(secondaryColor).fontSize(12).font('Helvetica-Bold')
       .text("POLICY INFORMATION", 50, policyY);
    
    doc.fillColor('black').fontSize(10).font('Helvetica');
    doc.text(`Product Type: ${plan?.name || 'Insurance Plan'}`, 50, policyY + 25);
    doc.text(`Certificate/Policy No.: ${sale.policy_number || ''}`, doc.page.width - 250, policyY + 25);

    if (plan?.coverage) {
      doc.text(`Coverage Summary: ${plan.coverage}`, 50, policyY + 40);
    }

    // PAYMENT DETAILS Section
    const paymentY = policyY + 80;
    doc.fillColor(secondaryColor).fontSize(12).font('Helvetica-Bold')
       .text("PAYMENT DETAILS", 50, paymentY);

    // Payment table
    const tableY = paymentY + 30;
    const tableWidth = 500;
    const rowHeight = 25;
    
    // Table header
    doc.rect(50, tableY, tableWidth, 30).fill(lightGray).stroke('#cccccc');
    doc.fillColor('black').fontSize(10).font('Helvetica-Bold');
    doc.text("Description", 70, tableY + 10);
    doc.text("Amount", 450, tableY + 10);

    // Table rows
    let currentY = tableY + 30;
    
    // Premium row
    doc.rect(50, currentY, tableWidth, rowHeight).fill(white).stroke('#cccccc');
    doc.fillColor('black').fontSize(10).font('Helvetica');
    doc.text("Premium", 70, currentY + 8);
    doc.text(`${subtotal}`, 450, currentY + 8);
    currentY += rowHeight;

    // Tax row
    doc.rect(50, currentY, tableWidth, rowHeight).fill(white).stroke('#cccccc');
    doc.text("Taxes/Fees", 70, currentY + 8);
    doc.text(`${tax || 0}`, 450, currentY + 8);
    currentY += rowHeight;

    // Total row
    doc.rect(50, currentY, tableWidth, rowHeight).fill(lightGray).stroke('#cccccc');
    doc.fillColor('black').fontSize(10).font('Helvetica-Bold');
    doc.text("TOTAL", 70, currentY + 8);
    doc.text(`${total}`, 450, currentY + 8);

    // Payment status
    doc.fillColor('black').fontSize(10).font('Helvetica');
    doc.text("Payment Status: Payment status will be updated in the admin portal.", 50, currentY + 40);

    // ISSUER DETAILS Section
    const issuerY = currentY + 80;
    doc.fillColor(secondaryColor).fontSize(12).font('Helvetica-Bold')
       .text("ISSUER DETAILS", 50, issuerY);
    
    const issuerAddress = (countryOfResidence && String(countryOfResidence).trim()) ? String(countryOfResidence).trim() : null;
    doc.fillColor('black').fontSize(10).font('Helvetica');
    doc.text("Issued By: AssurAssistance", 50, issuerY + 25);
    doc.text("Contact: 0123-456789 / contact@assurassistance.com", doc.page.width - 300, issuerY + 25);
    doc.text(issuerAddress ? `Address: ${issuerAddress}` : "Address: —", 50, issuerY + 40);

    // NOTES/DISCLAIMER Section
    const notesY = issuerY + 80;
    doc.fillColor(secondaryColor).fontSize(12).font('Helvetica-Bold')
       .text("NOTES / DISCLAIMER", 50, notesY);
    
    // Disclaimer box
    doc.rect(50, notesY + 25, tableWidth, 50).fill(lightGray).stroke('#cccccc');
    doc.fillColor('black').fontSize(9).font('Helvetica');
    doc.text('"This invoice is generated for the travel insurance coverage purchased under the referenced certificate. It is subject to the terms and conditions of the policy."', 
             70, notesY + 35, { width: 460, align: 'left' });

    doc.end();

    if (!returnBuffer) {
      stream.on("finish", () => resolve(`/uploads/invoices/${fileName}`));
      stream.on("error", (err) => reject(err));
    }
  });
};

export const generateCertificatePDF = async ({ certificateNumber, sale, traveller, plan, productType, countryOfResidence, guaranteesDetails = [] }, returnBuffer = false) => {
  const doc = new PDFDocument({ size: "A4", margin: 50 });
  const benefits = Array.isArray(guaranteesDetails) ? guaranteesDetails : [];

  return new Promise((resolve, reject) => {
    let stream;
    let chunks = [];
    
    if (returnBuffer) {
      // For buffer mode - collect chunks
      doc.on('data', (chunk) => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);
    } else {
      // For file mode - save to storage
      ensureDir(path.join(process.cwd(), "uploads", "certificates"));
      const fileName = `${certificateNumber}.pdf`;
      const filePath = path.join(process.cwd(), "uploads", "certificates", fileName);
      stream = fs.createWriteStream(filePath);
      doc.pipe(stream);
    }

    // COLORS
    const primaryColor = "#1c398e";
    const secondaryColor = "#0f172b";
    const white = "#FFFFFF";
    const lightGray = "#f8f9fa";
    const darkGray = "#666666";

    // HEADER SECTION
    doc.rect(0, 0, doc.page.width, 80).fill(white);
    
    // LOGO (if exists)
    const logoPath = path.join(process.cwd(), "public", "logo.png");
    if (fs.existsSync(logoPath)) {
      doc.image(logoPath, 50, 20, { width: 60, height: 40 });
    } else {
      // Logo placeholder
      doc.rect(50, 20, 60, 40).fill(lightGray).stroke('#cccccc');
      doc.fillColor(darkGray).fontSize(10).text("LOGO", 65, 35);
    }

    // UNIVERSAL CERTIFICATE title
    doc.fillColor(primaryColor).fontSize(24).font('Helvetica-Bold')
       .text("UNIVERSAL CERTIFICATE", 0, 30, { align: 'center' });

    // Horizontal line
    doc.moveTo(50, 85).lineTo(doc.page.width - 50, 85).stroke(primaryColor);

    doc.moveDown(4);

    // COMPANY SECTION
    doc.fillColor(secondaryColor).fontSize(14).font('Helvetica-Bold')
       .text("AssurAssistance", 0, 120, { align: 'center' });
    doc.fillColor(darkGray).fontSize(10).font('Helvetica')
       .text("(Insurance & Travel Services)", 0, 140, { align: 'center' });

    // Product-specific title
    let certificateTitle = "Certificate of Insurance";
    if (productType === "Travel") certificateTitle = "Certificate of Travel";
    if (productType === "Bank") certificateTitle = "Certificate of Bank";
    if (productType === "Health Evacuation") certificateTitle = "Certificate of Health Evacuation";
    if (productType === "Travel Inbound") certificateTitle = "Certificate of Travel Inbound";

    doc.fillColor(primaryColor).fontSize(18).font('Helvetica-Bold')
       .text(certificateTitle, 0, 180, { align: 'center' });

    doc.fillColor(darkGray).fontSize(10).font('Helvetica')
       .text(`(${productType || 'Insurance'})`, 0, 205, { align: 'center' });

    doc.moveDown(6);

    // MAIN CONTENT
    const contentY = 260;
    doc.fillColor('black').fontSize(11).font('Helvetica');
    doc.text("This is to formally certify that", 50, contentY, { align: 'left' });

    doc.moveDown(1);
    doc.fillColor('black').fontSize(11).font('Helvetica-Bold');
    doc.text(`Recipient Full Name: ${traveller.full_name}`, 50, doc.y);
    
    if (traveller.passport_or_id) {
      doc.text(`ID / Passport / Customer Number: ${traveller.passport_or_id}`, 50, doc.y + 20);
    }

    doc.moveDown(3);
    doc.fillColor('black').fontSize(11).font('Helvetica');
    doc.text("has successfully met the required standards and qualifications for the issuance of this certificate.", 50, doc.y);

    doc.moveDown(1.5);
    doc.text("This recognition is granted in acknowledgment of the recipient's compliance with all necessary guidelines, rules, and regulations as stipulated by AssurAssistance.", 50, doc.y, { width: 500 });

    // Purpose section
    const purposeText = productType === "Travel" ? "international travel" :
                       productType === "Bank" ? "banking verification" :
                       productType === "Health Evacuation" ? "emergency health evacuation" :
                       productType === "Travel Inbound" ? "inbound clearance" :
                       "insurance coverage";

    doc.moveDown(1.5);
    doc.text(`The purpose of this certificate is to validate and officially recognize the recipient's eligibility for ${purposeText}.`, 50, doc.y, { width: 500 });

    doc.moveDown(1.5);
    doc.text("This certificate serves as an official document and may be presented to the relevant authorities, institutions, or agencies as proof of authorization.", 50, doc.y, { width: 500 });

    // Certificate details
    doc.moveDown(3);
    doc.fillColor(secondaryColor).fontSize(10).font('Helvetica');
    doc.text(`Certificate No: ${certificateNumber}`, 50, doc.y);
    doc.text(`Policy No: ${sale.policy_number || ''}`, 50, doc.y + 15);

    // Benefits table (as indicated when the plan was created)
    if (benefits.length > 0) {
      doc.moveDown(3);
      doc.fillColor(secondaryColor).fontSize(12).font('Helvetica-Bold')
         .text("Benefits / Coverage", 50, doc.y);
      doc.moveDown(1);
      const tableStartY = doc.y;
      const tableWidth = 500;
      const col1 = 70;
      const col2 = 280;
      const col3 = 420;
      const rowH = 22;
      doc.rect(50, tableStartY, tableWidth, rowH).fill(lightGray).stroke('#cccccc');
      doc.fillColor('black').fontSize(9).font('Helvetica-Bold');
      doc.text("Category", col1, tableStartY + 6);
      doc.text("Coverage Type", col2, tableStartY + 6);
      doc.text("Amount", col3, tableStartY + 6);
      let currentTableY = tableStartY + rowH;
      doc.font('Helvetica');
      for (const row of benefits) {
        doc.rect(50, currentTableY, tableWidth, rowH).fill(white).stroke('#cccccc');
        doc.fillColor('black').fontSize(9);
        doc.text(String(row.category || '—'), col1, currentTableY + 6, { width: 200 });
        doc.text(String(row.coverageType || '—'), col2, currentTableY + 6, { width: 130 });
        doc.text(String(row.amount != null ? row.amount : '—'), col3, currentTableY + 6);
        currentTableY += rowH;
      }
      doc.y = currentTableY + 10;
    }

    const issueLocation = (countryOfResidence && String(countryOfResidence).trim()) ? String(countryOfResidence).trim() : null;

    // Issue date and location
    doc.moveDown(4);
    doc.fillColor('black').fontSize(11).font('Helvetica');
    doc.text(issueLocation
      ? `Issued on this ${new Date().toLocaleDateString()}, at ${issueLocation}, under the seal and authority of AssurAssistance.`
      : `Issued on this ${new Date().toLocaleDateString()}, under the seal and authority of AssurAssistance.`,
      50, doc.y, { width: 500 });

    // Footer - moved to bottom of page
    const footerY = doc.page.height - 120;
    doc.fillColor(darkGray).fontSize(9).font('Helvetica')
       .text("This certificate is issued electronically and is valid without signature.", 0, footerY, { align: 'center' });

    doc.moveDown(1);
    doc.fontSize(8)
       .text(issueLocation ? `AssurAssistance — ${issueLocation} — 0123-456789` : "AssurAssistance — 0123-456789", 0, footerY + 20, { align: 'center' });

    doc.end();

    if (!returnBuffer) {
      stream.on("finish", () => resolve(`/uploads/certificates/${fileName}`));
      stream.on("error", (err) => reject(err));
    }
  });
};