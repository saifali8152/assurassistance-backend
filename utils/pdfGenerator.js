import PDFDocument from "pdfkit";
import fs from "fs";
import path from "path";

const ensureDir = (dir) => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
};

const ORANGE = "#E4590F";

const INVOICE_I18N = {
  en: {
    invoiceNo: "Invoice No.:",
    issueDate: "Issue Date:",
    billTo: "BILL TO",
    name: "Name:",
    passport: "Passport/ID:",
    contact: "Contact:",
    policyInfo: "POLICY INFORMATION",
    productType: "Product Type:",
    certNo: "Certificate/Policy No.:",
    coverageSummary: "Coverage Summary:",
    paymentDetails: "PAYMENT DETAILS",
    description: "Description",
    amount: "Amount",
    premiumPlanRate: "Premium (plan rate)",
    taxesFees: "Taxes/Fees",
    total: "TOTAL",
    paymentStatus: "Payment Status:",
    paymentStatusNote: "Payment status will be updated in the admin portal.",
    issuer: "ISSUER DETAILS",
    issuedBy: "Issued By: Assur'Assistance",
    contactLine: "Contact: +225 07 18 92 31 94 / commercial@assurassistance.org",
    address: "Address:",
    notes: "NOTES / DISCLAIMER",
    disclaimer:
      '"This invoice is generated for the travel insurance coverage purchased under the referenced certificate. Premium amounts reflect the applicable plan rate (not benefit coverage limits). Subject to the terms and conditions of the policy."'
  },
  fr: {
    invoiceNo: "N° de facture :",
    issueDate: "Date d'émission :",
    billTo: "FACTURÉ À",
    name: "Nom :",
    passport: "Passeport / pièce d'identité :",
    contact: "Contact :",
    policyInfo: "INFORMATIONS SUR LA POLICE",
    productType: "Type de produit :",
    certNo: "N° certificat / police :",
    coverageSummary: "Résumé de la couverture :",
    paymentDetails: "DÉTAIL DU PAIEMENT",
    description: "Description",
    amount: "Montant",
    premiumPlanRate: "Prime (tarif du plan)",
    taxesFees: "Taxes et frais",
    total: "TOTAL",
    paymentStatus: "Statut du paiement :",
    paymentStatusNote: "Le statut du paiement sera mis à jour dans le portail administrateur.",
    issuer: "ÉMETTEUR",
    issuedBy: "Émis par : Assur'Assistance",
    contactLine: "Contact : +225 07 18 92 31 94 / commercial@assurassistance.org",
    address: "Adresse :",
    notes: "NOTES / CLAUSE DE NON-RESPONSABILITÉ",
    disclaimer:
      "« La présente facture est établie pour la couverture d'assurance voyage souscrite sous le certificat mentionné. Les montants de prime reflètent le tarif du plan applicable (et non les plafonds de garantie). Sous réserve des conditions générales de la police. »"
  }
};

function tryImagePath(...candidates) {
  for (const p of candidates) {
    if (p && fs.existsSync(p)) return p;
  }
  return null;
}

function formatMoney(amount, currency = "XOF", locale = "en") {
  const n = Number(amount);
  if (Number.isNaN(n)) return String(amount);
  const cur = (currency || "XOF").toUpperCase();
  const sym = cur === "XOF" ? " FCFA" : ` ${cur}`;
  const loc = locale === "fr" ? "fr-FR" : "en-US";
  return `${n.toLocaleString(loc, { minimumFractionDigits: 0, maximumFractionDigits: 2 })}${sym}`;
}

function formatIssueDate(locale) {
  const d = new Date();
  const loc = locale === "fr" ? "fr-FR" : "en-US";
  return d.toLocaleDateString(loc);
}

/**
 * Invoice PDF — amounts are the actual premium rate (plan_price), not coverage limits.
 * @param {object} opts
 * @param {string} [opts.invoiceTitle] — "INVOICE" or "FACTURE"
 * @param {string} [opts.locale] — "en" | "fr" — labels and number/date formatting
 * @param {string} [opts.partnerLogoFsPath] — optional absolute path to partner logo image
 */
export const generateInvoicePDF = async (
  {
    invoiceNumber,
    sale,
    traveller,
    plan,
    subtotal,
    tax,
    total,
    countryOfResidence,
    partnerLogoFsPath = null,
    invoiceTitle = "INVOICE",
    currency = "XOF",
    locale = "en"
  },
  returnBuffer = false
) => {
  const doc = new PDFDocument({ size: "A4", margin: 50 });
  const L = INVOICE_I18N[locale === "fr" ? "fr" : "en"];

  return new Promise((resolve, reject) => {
    let stream;
    const chunks = [];

    if (returnBuffer) {
      doc.on("data", (chunk) => chunks.push(chunk));
      doc.on("end", () => resolve(Buffer.concat(chunks)));
      doc.on("error", reject);
    } else {
      ensureDir(path.join(process.cwd(), "uploads", "invoices"));
      const fileName = `${invoiceNumber}.pdf`;
      const filePath = path.join(process.cwd(), "uploads", "invoices", fileName);
      stream = fs.createWriteStream(filePath);
      doc.pipe(stream);
    }

    const secondaryColor = "#0f172b";
    const white = "#FFFFFF";
    const lightGray = "#f8f9fa";
    const darkGray = "#666666";
    const cwd = process.cwd();

    const mainLogo = tryImagePath(
      path.join(cwd, "..", "frontend", "public", "full-logo.png"),
      path.join(cwd, "public", "full-logo.png"),
      path.join(cwd, "public", "logo.png")
    );

    const partnerPath =
      partnerLogoFsPath && fs.existsSync(partnerLogoFsPath) ? partnerLogoFsPath : null;

    doc.rect(0, 0, doc.page.width, 88).fill(white);

    const leftX = 50;
    const rightEdge = doc.page.width - 50;

    if (mainLogo) {
      try {
        doc.image(mainLogo, leftX, 22, { height: 38, fit: [150, 38] });
      } catch {
        /* ignore */
      }
    } else {
      doc.rect(leftX, 22, 70, 38).fill(lightGray).stroke("#cccccc");
      doc.fillColor(darkGray).fontSize(10).text("LOGO", leftX + 22, 36);
    }

    if (partnerPath) {
      try {
        doc.image(partnerPath, rightEdge - 120, 24, { height: 36, fit: [110, 36] });
      } catch {
        /* ignore */
      }
    }

    doc.fillColor(ORANGE).fontSize(26).font("Helvetica-Bold").text(invoiceTitle, rightEdge - 200, 28, {
      width: 200,
      align: "right"
    });

    doc.moveTo(50, 92).lineTo(doc.page.width - 50, 92).stroke("#cccccc");

    const invoiceDetailsY = 108;
    doc.fillColor("black").fontSize(10).font("Helvetica");
    doc.text(`${L.invoiceNo}`, rightEdge - 250, invoiceDetailsY);
    doc.text(`${invoiceNumber}`, rightEdge - 150, invoiceDetailsY);

    doc.text(`${L.issueDate}`, rightEdge - 250, invoiceDetailsY + 15);
    doc.text(`${formatIssueDate(locale === "fr" ? "fr" : "en")}`, rightEdge - 150, invoiceDetailsY + 15);

    doc.fillColor(secondaryColor).fontSize(12).font("Helvetica-Bold").text(L.billTo, leftX, invoiceDetailsY + 50);

    doc.fillColor("black").fontSize(10).font("Helvetica");
    doc.text(`${L.name} ${traveller.full_name}`, leftX, invoiceDetailsY + 75);

    if (traveller.passport_or_id) {
      doc.text(`${L.passport} ${traveller.passport_or_id}`, leftX, invoiceDetailsY + 90);
    }

    if (traveller.phone) {
      doc.text(`${L.contact} ${traveller.phone}`, rightEdge - 250, invoiceDetailsY + 90);
    }

    const policyY = invoiceDetailsY + 130;
    doc.fillColor(secondaryColor).fontSize(12).font("Helvetica-Bold").text(L.policyInfo, leftX, policyY);

    doc.fillColor("black").fontSize(10).font("Helvetica");
    doc.text(`${L.productType} ${plan?.name || "Insurance Plan"}`, leftX, policyY + 25);
    doc.text(`${L.certNo} ${sale.policy_number || ""}`, rightEdge - 250, policyY + 25);

    if (plan?.coverage) {
      doc.text(`${L.coverageSummary} ${plan.coverage}`, leftX, policyY + 40, { width: 480, lineGap: 2 });
    }

    const paymentY = plan?.coverage ? policyY + 95 : policyY + 80;
    doc.fillColor(secondaryColor).fontSize(12).font("Helvetica-Bold").text(L.paymentDetails, leftX, paymentY);

    const tableY = paymentY + 30;
    const tableWidth = 500;
    const rowHeight = 25;

    doc.rect(leftX, tableY, tableWidth, 30).fill(lightGray).stroke("#cccccc");
    doc.fillColor("black").fontSize(10).font("Helvetica-Bold");
    doc.text(L.description, leftX + 20, tableY + 10);
    doc.text(L.amount, rightEdge - 120, tableY + 10);

    let currentY = tableY + 30;

    const subNum = Number(subtotal);
    const taxNum = Number(tax) || 0;
    const totNum = Number(total);

    doc.rect(leftX, currentY, tableWidth, rowHeight).fill(white).stroke("#cccccc");
    doc.fillColor("black").fontSize(10).font("Helvetica");
    doc.text(L.premiumPlanRate, leftX + 20, currentY + 8);
    doc.text(formatMoney(subNum, currency, locale), rightEdge - 120, currentY + 8, { width: 100, align: "right" });
    currentY += rowHeight;

    doc.rect(leftX, currentY, tableWidth, rowHeight).fill(white).stroke("#cccccc");
    doc.text(L.taxesFees, leftX + 20, currentY + 8);
    doc.text(formatMoney(taxNum, currency, locale), rightEdge - 120, currentY + 8, { width: 100, align: "right" });
    currentY += rowHeight;

    doc.rect(leftX, currentY, tableWidth, rowHeight).fill(lightGray).stroke("#cccccc");
    doc.fillColor("black").fontSize(10).font("Helvetica-Bold");
    doc.text(L.total, leftX + 20, currentY + 8);
    doc.text(formatMoney(totNum, currency, locale), rightEdge - 120, currentY + 8, { width: 100, align: "right" });

    doc.fillColor("black").fontSize(10).font("Helvetica");
    doc.text(`${L.paymentStatus} ${L.paymentStatusNote}`, leftX, currentY + 40);

    const issuerY = currentY + 80;
    doc.fillColor(secondaryColor).fontSize(12).font("Helvetica-Bold").text(L.issuer, leftX, issuerY);

    const issuerAddress =
      countryOfResidence && String(countryOfResidence).trim() ? String(countryOfResidence).trim() : null;
    doc.fillColor("black").fontSize(10).font("Helvetica");
    doc.text(L.issuedBy, leftX, issuerY + 25);
    doc.text(L.contactLine, rightEdge - 320, issuerY + 25, { width: 300, align: "right" });
    doc.text(issuerAddress ? `${L.address} ${issuerAddress}` : `${L.address} —`, leftX, issuerY + 40);

    const notesY = issuerY + 80;
    doc.fillColor(secondaryColor).fontSize(12).font("Helvetica-Bold").text(L.notes, leftX, notesY);

    doc.rect(leftX, notesY + 25, tableWidth, 50).fill(lightGray).stroke("#cccccc");
    doc.fillColor("black").fontSize(9).font("Helvetica");
    doc.text(L.disclaimer, leftX + 20, notesY + 35, { width: 460, align: "left" });

    doc.end();

    if (!returnBuffer) {
      const fileName = `${invoiceNumber}.pdf`;
      stream.on("finish", () => resolve(`/uploads/invoices/${fileName}`));
      stream.on("error", (err) => reject(err));
    }
  });
};
