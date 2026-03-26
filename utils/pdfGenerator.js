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
