import PDFDocument from "pdfkit";
import fs from "fs";
import path from "path";
import {
  normalizeCurrency,
  currencyLabel,
  formatFromXof,
  formatAmountCell,
} from "./currencyDisplay.js";

const ORANGE = "#E4590F";
const DARK = "#333333";
const GRAY = "#666666";
const LIGHT = "#f8f9fa";
const HIGHLIGHT = "#fde5d8";

const COMPANY = {
  name: "Assur'Assistance",
  address: process.env.COMPANY_ADDRESS || "04BP2534 Abidjan 04 ; Plateau Résidence Neuilly",
  phone: process.env.COMPANY_PHONE || "0757153337",
  email: process.env.COMPANY_EMAIL || "commercial01@assurassistance.org",
};

const I18N = {
  fr: {
    title: "FACTURE DE PRIMES D'ASSURANCE VOYAGE",
    subtitle: "(Assur'Assistance)",
    address: "Adresse :",
    phone: "Téléphone :",
    tel: "N°Tel :",
    email: "Email :",
    billedTo: "FACTURÉ À :",
    agencyName: "Nom de l'agence de voyage :",
    invoiceNo: "Facture N° :",
    issueDate: "Date d'émission :",
    billingPeriod: "Période de facturation :",
    fromTo: (a, b) => `Du ${a} au ${b}`,
    detailTitle: "DÉTAIL DES PRIMES",
    columns: {
      sale_id: "Sale ID", case_id: "Case ID", traveller_name: "Traveller Name",
      traveller_phone: "Phone", plan_name: "Plan", policy_number: "Policy Num",
      certificate_number: "Certificate Number", plan_premium: "Premium",
      tax: "Tax", total: "Total", received_amount: "Received", payment_status: "Payment",
      confirmed_at: "Confirmed", created_by_name: "Created By", commission: "Commissions",
    },
    totalIssued: "Total Polices émises",
    totalCommissions: "Total commissions à déduire",
    netToTransfer: "Total net à transférer",
    discountRate: (pct) => `Remise appliquée : ${pct} %`,
    paymentTitle: "MODALITÉS DE PAIEMENT",
    paymentMode: "Mode : Mobile money (Qr Code de reversement)",
    observationsTitle: "Observations :",
    observations: "Merci de bien vouloir procéder au règlement dans les délais indiqués.",
    signature: "Signature et cachet",
    noSales: "Aucune vente confirmée sur la période.",
  },
  en: {
    title: "TRAVEL INSURANCE PREMIUM INVOICE",
    subtitle: "(Assur'Assistance)",
    address: "Address:",
    phone: "Phone:",
    tel: "Tel:",
    email: "Email:",
    billedTo: "BILLED TO:",
    agencyName: "Travel agency name:",
    invoiceNo: "Invoice No:",
    issueDate: "Issue date:",
    billingPeriod: "Billing period:",
    fromTo: (a, b) => `From ${a} to ${b}`,
    detailTitle: "PREMIUM BREAKDOWN",
    columns: {
      sale_id: "Sale ID", case_id: "Case ID", traveller_name: "Traveller Name",
      traveller_phone: "Phone", plan_name: "Plan", policy_number: "Policy Num",
      certificate_number: "Certificate Number", plan_premium: "Premium",
      tax: "Tax", total: "Total", received_amount: "Received", payment_status: "Payment",
      confirmed_at: "Confirmed", created_by_name: "Created By", commission: "Commissions",
    },
    totalIssued: "Total policies issued",
    totalCommissions: "Total commissions to deduct",
    netToTransfer: "Net total to transfer",
    discountRate: (pct) => `Discount applied: ${pct}%`,
    paymentTitle: "PAYMENT TERMS",
    paymentMode: "Mode: Mobile money (transfer QR code)",
    observationsTitle: "Observations:",
    observations: "Please proceed with payment within the indicated deadlines.",
    signature: "Signature and stamp",
    noSales: "No confirmed sales in this period.",
  },
};

const MONTHS_FR = ["JANVIER", "FÉVRIER", "MARS", "AVRIL", "MAI", "JUIN", "JUILLET", "AOÛT", "SEPTEMBRE", "OCTOBRE", "NOVEMBRE", "DÉCEMBRE"];
const MONTHS_EN = ["JANUARY", "FEBRUARY", "MARCH", "APRIL", "MAY", "JUNE", "JULY", "AUGUST", "SEPTEMBER", "OCTOBER", "NOVEMBER", "DECEMBER"];

function tryImagePath(...candidates) {
  for (const p of candidates) {
    try { if (p && fs.existsSync(p)) return p; } catch {}
  }
  return null;
}

function fmtDate(d) {
  const x = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(x.getTime())) return "";
  const dd = String(x.getDate()).padStart(2, "0");
  const mm = String(x.getMonth() + 1).padStart(2, "0");
  return `${dd}/${mm}/${x.getFullYear()}`;
}

function fmtShortDate(d) {
  const x = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(x.getTime())) return "";
  return `${x.getMonth() + 1}/${x.getDate()}/${x.getFullYear()}`;
}

/**
 * Period label: full-month periods become "JUIN 2026", anything else a date range.
 */
function periodLabel(startDate, endDate, locale) {
  const s = new Date(`${startDate}T00:00:00`);
  const e = new Date(`${endDate}T00:00:00`);
  const months = locale === "fr" ? MONTHS_FR : MONTHS_EN;
  const lastDay = new Date(e.getFullYear(), e.getMonth() + 1, 0).getDate();
  if (
    s.getFullYear() === e.getFullYear() && s.getMonth() === e.getMonth() &&
    s.getDate() === 1 && e.getDate() === lastDay
  ) {
    return `${months[s.getMonth()]} ${s.getFullYear()}`;
  }
  return `${fmtDate(s)} - ${fmtDate(e)}`;
}

function dashedSeparator(doc, x, y, width) {
  doc.save();
  doc.strokeColor(GRAY).lineWidth(0.8).dash(3, { space: 2 });
  doc.moveTo(x, y).lineTo(x + width, y).stroke();
  doc.undash();
  doc.restore();
}

// Table columns (portrait A4, 25pt margins -> 545pt usable)
const COLUMNS = [
  { key: "sale_id", w: 22 },
  { key: "case_id", w: 22 },
  { key: "traveller_name", w: 72 },
  { key: "traveller_phone", w: 42 },
  { key: "plan_name", w: 36 },
  { key: "policy_number", w: 44 },
  { key: "certificate_number", w: 54 },
  { key: "plan_premium", w: 28, align: "right" },
  { key: "tax", w: 14, align: "right" },
  { key: "total", w: 28, align: "right" },
  { key: "received_amount", w: 28, align: "right" },
  { key: "payment_status", w: 24 },
  { key: "confirmed_at", w: 34 },
  { key: "created_by_name", w: 62 },
  { key: "commission", w: 34, align: "right" },
];

function cellText(line, key, currency, locale) {
  switch (key) {
    case "plan_premium":
    case "tax":
    case "total":
    case "received_amount":
    case "commission":
      return formatAmountCell(line[key], currency, locale);
    case "confirmed_at":
      return fmtShortDate(line.confirmed_at);
    default:
      return String(line[key] ?? "");
  }
}

/**
 * Generate the partner (travel agency) premium invoice PDF.
 * Amounts in `lines` / `totals` are stored in XOF and converted for display via `currency`.
 * Returns a Buffer.
 */
export const generatePartnerInvoicePDF = async ({
  invoiceNumber,
  partner,          // { name, company_name, geographical_location, work_phone, whatsapp_phone, email }
  lines,            // rows from getPartnerSalesForPeriod (amounts in XOF)
  totals,           // { totalPremiums, totalCommissions, netToTransfer } in XOF
  startDate,
  endDate,
  partnerLogoFsPath = null,
  locale = "fr",
  currency = "XOF",
}) => {
  const L = I18N[locale === "fr" ? "fr" : "en"];
  const displayCurrency = normalizeCurrency(currency);
  const curLabel = currencyLabel(displayCurrency);
  const margin = 25;
  const doc = new PDFDocument({ size: "A4", margin });

  return new Promise((resolve, reject) => {
    const chunks = [];
    doc.on("data", (c) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const leftX = margin;
    const pageW = doc.page.width;
    const usable = pageW - margin * 2;
    const rightEdge = pageW - margin;
    const cwd = process.cwd();

    const mainLogo = tryImagePath(
      path.join(cwd, "..", "frontend", "public", "full-logo.png"),
      path.join(cwd, "public", "full-logo.png"),
      path.join(cwd, "public", "logo.png")
    );
    const partnerLogo =
      partnerLogoFsPath && fs.existsSync(partnerLogoFsPath) ? partnerLogoFsPath : null;

    // ---------- Header: company logo left, insurer logo (e.g. GNA) right ----------
    const headerTop = 25;
    const logoH = 42;
    if (mainLogo) {
      try { doc.image(mainLogo, leftX, headerTop, { fit: [150, logoH] }); } catch {}
    }
    if (partnerLogo) {
      try { doc.image(partnerLogo, rightEdge - 130, headerTop, { fit: [130, logoH] }); } catch {}
    }
    doc.fillColor(ORANGE).font("Helvetica-Bold").fontSize(10.5);
    doc.text(L.title, leftX + 155, headerTop + 8, {
      width: usable - 300, align: "center", height: 12, lineBreak: false, ellipsis: false,
    });
    doc.fillColor(DARK).font("Helvetica").fontSize(8);
    doc.text(L.subtitle, leftX + 155, headerTop + 22, {
      width: usable - 300, align: "center", height: 10, lineBreak: false,
    });

    // ---------- Assur'Assistance block ----------
    let y = headerTop + logoH + 30;
    const blockX = leftX + 25;
    doc.fillColor(DARK).font("Helvetica-Bold").fontSize(10).text(COMPANY.name, blockX, y);
    y += 15;
    doc.font("Helvetica").fontSize(9).fillColor(GRAY);
    doc.fillColor(GRAY).text(`${L.address} `, blockX, y, { continued: true })
      .fillColor(DARK).font("Helvetica-Bold").text(COMPANY.address);
    y += 14;
    doc.font("Helvetica").fillColor(GRAY).text(`${L.phone} `, blockX, y, { continued: true })
      .fillColor(DARK).font("Helvetica-Bold").text(COMPANY.phone);
    y += 14;
    doc.font("Helvetica").fillColor(GRAY).text(`${L.email} `, blockX, y, { continued: true })
      .fillColor("#1a56db").font("Helvetica-Bold").text(COMPANY.email, { underline: true });
    doc.font("Helvetica").fillColor(DARK);
    y += 24;
    dashedSeparator(doc, blockX, y, 230);
    y += 18;

    // ---------- Billed to (travel agency) ----------
    const agencyName = partner.company_name || partner.name || "";
    const agencyAddress = partner.geographical_location || "";
    const agencyPhone = partner.work_phone || partner.whatsapp_phone || "";
    const agencyEmail = partner.email || "";

    doc.fillColor(DARK).font("Helvetica-Bold").fontSize(11).text(L.billedTo, blockX, y);
    y += 18;
    doc.fontSize(9).font("Helvetica").fillColor(GRAY)
      .text(`${L.agencyName} `, blockX, y, { continued: true })
      .fillColor(DARK).font("Helvetica-Bold").text(agencyName.toUpperCase());
    y += 14;
    doc.font("Helvetica").fillColor(GRAY).text(`${L.address} `, blockX, y, { continued: true })
      .fillColor(DARK).text(agencyAddress);
    y += 14;
    doc.fillColor(GRAY).text(`${L.tel} `, blockX, y, { continued: true })
      .fillColor(DARK).text(agencyPhone);
    y += 14;
    doc.fillColor(GRAY).text(`${L.email} `, blockX, y, { continued: true })
      .fillColor("#1a56db").text(agencyEmail, { underline: true });
    doc.fillColor(DARK);
    y += 24;

    // ---------- Invoice meta ----------
    doc.fillColor(GRAY).fontSize(9).text(`${L.invoiceNo} `, blockX, y, { continued: true })
      .fillColor(DARK).font("Helvetica-Bold").text(invoiceNumber);
    y += 18;
    doc.font("Helvetica").fillColor(GRAY).text(`${L.issueDate} `, blockX, y, { continued: true })
      .fillColor(DARK).text(fmtDate(new Date()));
    y += 18;
    doc.fillColor(GRAY).text(`${L.billingPeriod} `, blockX, y, { continued: true })
      .fillColor(DARK).font("Helvetica-Bold").text(periodLabel(startDate, endDate, locale));
    y += 13;
    doc.font("Helvetica").fillColor(DARK).text(
      L.fromTo(fmtDate(new Date(`${startDate}T00:00:00`)), fmtDate(new Date(`${endDate}T00:00:00`))),
      blockX, y
    );
    y += 22;
    dashedSeparator(doc, blockX, y, 230);
    y += 18;

    // ---------- Premium breakdown table ----------
    doc.fillColor(DARK).font("Helvetica-Bold").fontSize(11)
      .text(`${L.detailTitle} (${curLabel})`, blockX, y);
    y += 20;

    const rowH = 11;
    const tableFont = 5.5;

    const drawHeaderRow = (yy) => {
      doc.save();
      doc.rect(leftX, yy - 2, usable, rowH).fill(LIGHT);
      doc.restore();
      doc.fillColor(DARK).font("Helvetica-Bold").fontSize(tableFont);
      let x = leftX;
      for (const col of COLUMNS) {
        // height clamps every cell to a single line (ellipsis on overflow)
        doc.text(L.columns[col.key], x + 1, yy, {
          width: col.w - 2, height: 7, align: col.align || "left", lineBreak: false, ellipsis: true,
        });
        x += col.w;
      }
      doc.font("Helvetica");
      return yy + rowH;
    };

    const ensureSpace = (yy, needed) => {
      if (yy + needed <= doc.page.height - 40) return yy;
      doc.addPage();
      return drawHeaderRow(margin + 10);
    };

    y = drawHeaderRow(y);
    doc.fillColor(DARK).fontSize(tableFont);

    if (lines.length === 0) {
      doc.font("Helvetica").fontSize(9).fillColor(GRAY).text(L.noSales, leftX + 2, y + 4);
      y += 24;
    }

    for (const line of lines) {
      y = ensureSpace(y, rowH);
      let x = leftX;
      doc.fillColor(DARK).font("Helvetica").fontSize(tableFont);
      for (const col of COLUMNS) {
        doc.text(cellText(line, col.key, displayCurrency, locale), x + 1, y, {
          width: col.w - 2, height: 7, align: col.align || "left", lineBreak: false, ellipsis: true,
        });
        x += col.w;
      }
      doc.save();
      doc.strokeColor("#e5e7eb").lineWidth(0.4);
      doc.moveTo(leftX, y + rowH - 3).lineTo(rightEdge, y + rowH - 3).stroke();
      doc.restore();
      y += rowH;
    }

    // ---------- Totals ----------
    y = ensureSpace(y, 110);
    y += 10;
    const totalsLabelX = leftX + 230;
    const totalsValueX = leftX + 400;
    const totalsRow = (label, value, highlighted) => {
      if (highlighted) {
        doc.save();
        doc.rect(totalsLabelX - 4, y - 3, 260, 15).fill(HIGHLIGHT);
        doc.restore();
      }
      doc.fillColor(DARK).font("Helvetica-Bold").fontSize(8);
      doc.text(label, totalsLabelX, y, { width: 150, lineBreak: false });
      doc.text(formatFromXof(value, displayCurrency, locale), totalsValueX - 20, y, {
        width: 100, align: "right", lineBreak: false,
      });
      y += 20;
    };
    const discountPct = Number(totals.discountPct) || 0;
    if (discountPct > 0) {
      doc.fillColor(DARK).font("Helvetica-Bold").fontSize(8);
      doc.text(L.discountRate(discountPct), totalsLabelX, y, { width: 250, lineBreak: false });
      y += 18;
    }
    totalsRow(L.totalIssued, totals.totalPremiums, false);
    totalsRow(L.totalCommissions, totals.totalCommissions, true);
    totalsRow(L.netToTransfer, totals.netToTransfer, true);

    // ---------- Payment terms / observations / signature ----------
    y = ensureSpace(y, 170);
    y += 15;
    doc.fillColor(DARK).font("Helvetica-Bold").fontSize(10).text(L.paymentTitle, blockX, y);
    y += 20;
    doc.font("Helvetica").fontSize(9).text(L.paymentMode, blockX, y);
    y += 26;
    dashedSeparator(doc, blockX, y, 230);
    y += 14;
    doc.font("Helvetica").fontSize(9).fillColor(DARK).text(L.observationsTitle, blockX, y);
    y += 13;
    doc.text(L.observations, blockX, y);
    y += 26;
    dashedSeparator(doc, blockX, y, 230);
    y += 18;
    doc.text(L.signature, blockX, y);
    y += 26;
    doc.font("Helvetica-Bold").text(COMPANY.name, blockX, y);

    doc.end();
  });
};
