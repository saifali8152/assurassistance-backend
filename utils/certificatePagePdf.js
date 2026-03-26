/**
 * Certificate PDF matching the browser certificate print layout (English labels).
 * Compact single-page A4 for ZIP downloads and /sales/certificate/:id.
 */
import PDFDocument from "pdfkit";
import fs from "fs";
import path from "path";

const ORANGE = "#E4590F";
const GRAY_LINE = "#CCCCCC";

function groupBenefits(benefits) {
  if (!Array.isArray(benefits) || !benefits.length) return [];
  const order = ["MEDICAL", "TRIP PROTECTION", "LEGAL"];
  const map = new Map();
  for (const b of benefits) {
    const h = b.categoryHeader || b.category || "—";
    if (!map.has(h)) map.set(h, []);
    map.get(h).push(b);
  }
  return order.filter((k) => map.has(k)).map((k) => ({ header: k, rows: map.get(k) }));
}

function productSubtitle(productType) {
  const t = String(productType || "").trim();
  if (t === "Travel") return "(Travel)";
  if (t === "Travel Inbound") return "(Travel Inbound)";
  if (t === "Road travel") return "(Road travel)";
  return t ? `(${t})` : "(Insurance)";
}

function currencyLabel(c) {
  if (!c || c === "XOF") return "FCFA";
  return String(c);
}

function qrBufferFromDataUrl(dataUrl) {
  if (!dataUrl || typeof dataUrl !== "string") return null;
  const m = dataUrl.match(/^data:image\/png;base64,(.+)$/);
  if (!m) return null;
  try {
    return Buffer.from(m[1], "base64");
  } catch {
    return null;
  }
}

function tryImagePath(...candidates) {
  for (const p of candidates) {
    if (p && fs.existsSync(p)) return p;
  }
  return null;
}

/**
 * @param {object} payload same shape as getCertificatePageData JSON
 * @param {boolean} returnBuffer
 * @returns {Promise<Buffer|string>}
 */
export function generateCertificatePdfFromPagePayload(payload, returnBuffer = true) {
  const doc = new PDFDocument({
    size: "A4",
    margin: 20,
    bufferPages: true,
    info: { Title: "Insurance certificate", Author: "Assur Assistance" }
  });

  return new Promise((resolve, reject) => {
    const chunks = [];
    let stream;
    if (returnBuffer) {
      doc.on("data", (c) => chunks.push(c));
      doc.on("end", () => resolve(Buffer.concat(chunks)));
      doc.on("error", reject);
    } else {
      const dir = path.join(process.cwd(), "uploads", "certificates");
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const fileName = `${payload.certificateNumber}.pdf`;
      const filePath = path.join(dir, fileName);
      stream = fs.createWriteStream(filePath);
      doc.pipe(stream);
      stream.on("finish", () => resolve(`/uploads/certificates/${fileName}`));
      stream.on("error", reject);
    }

    const left = 20;
    const right = doc.page.width - 20;
    const w = right - left;
    let y = 20;

    const cwd = process.cwd();
    const mainLogo = tryImagePath(
      path.join(cwd, "public", "full-logo.png"),
      path.join(cwd, "public", "logo.png"),
      path.join(cwd, "..", "frontend", "public", "full-logo.png"),
      path.join(cwd, "..", "frontend", "public", "logo.png")
    );

    const headerH = 38;
    if (mainLogo) {
      try {
        doc.image(mainLogo, left, y, { height: 34, fit: [120, 34] });
      } catch {
        /* ignore */
      }
    }

    doc.fillColor(ORANGE).font("Helvetica-Bold").fontSize(11);
    doc.text("INSURANCE CERTIFICATE", left, y + 6, {
      width: w,
      align: "center"
    });
    doc.fillColor("#000").font("Helvetica").fontSize(7);
    doc.text(productSubtitle(payload.productType), left, y + 20, { width: w, align: "center" });

    y += headerH;
    doc.fillColor(ORANGE).rect(left, y, w, 2).fill();
    y += 8;

    doc.fillColor("#000").font("Helvetica").fontSize(7.5);
    doc.text(
      "This is to certify that the insured has a valid travel insurance policy, providing coverage as detailed in the terms and conditions :",
      left,
      y,
      { width: w, lineGap: 1 }
    );
    y = doc.y + 6;

    const rowH = 12;
    const mid = left + w / 2;

    function section(title) {
      doc.font("Helvetica-Bold").fontSize(8).fillColor("#000").text(title, left, y);
      y += 10;
    }

    function row2(l1, v1, l2, v2) {
      const v1s = (v1 || "—").toString();
      const v2s = (v2 || "—").toString();
      doc.font("Helvetica-Oblique").fontSize(6.5).fillColor("#333");
      doc.text(`${l1}:`, left, y);
      doc.font("Helvetica-Bold").fillColor("#000");
      doc.text(v1s, left + 58, y, { width: mid - left - 64, ellipsis: true });
      doc.font("Helvetica-Oblique").fillColor("#333");
      doc.text(`${l2}:`, mid, y);
      doc.font("Helvetica-Bold").fillColor("#000");
      doc.text(v2s, mid + 58, y, { width: right - mid - 58, ellipsis: true });
      y += rowH;
      doc
        .moveTo(left, y - 2)
        .lineTo(right, y - 2)
        .strokeColor(GRAY_LINE)
        .lineWidth(0.3)
        .stroke();
    }

    function rowFull(l1, v1) {
      doc.font("Helvetica-Oblique").fontSize(6.5).fillColor("#333");
      doc.text(`${l1}:`, left, y);
      doc.font("Helvetica-Bold").fillColor("#000");
      doc.text((v1 || "—").toString(), left + 58, y, { width: w - 60, ellipsis: true });
      y += rowH;
      doc
        .moveTo(left, y - 2)
        .lineTo(right, y - 2)
        .strokeColor(GRAY_LINE)
        .lineWidth(0.3)
        .stroke();
    }

    section("Insured");
    const tr = payload.traveller || {};
    row2("Given Names", (tr.givenNames || "").toUpperCase(), "Surname", (tr.surname || "").toUpperCase());
    row2("Date of Birth", tr.dateOfBirth, "N° Passport", tr.passportOrId);
    row2("Gender", tr.gender, "Nationality", tr.nationality);
    rowFull("Country of residence", tr.countryOfResidence);

    const scope = (payload.coverage && payload.coverage.worldwideLabel) || "Worldwide";
    section(`Coverage Details – ${scope}`);
    const cov = payload.coverage || {};
    const period = `From ${cov.periodFrom || "—"} to ${cov.periodTo || "—"}`;
    row2("Period of stay", period, "N° Days", String(cov.stayDays ?? "—"));
    row2(
      "Destination(s)",
      (cov.destinations || "—").toString().toUpperCase(),
      "Validity (N° Days)",
      String(cov.validityDays ?? "—")
    );
    row2("Email", cov.email, "Phone Number", cov.phone);
    row2("Plan", cov.planName, "Currency", currencyLabel(cov.currency));

    const pr = payload.pricing || {};
    if (
      pr.ageMultiplier != null ||
      (pr.ageBand != null && String(pr.ageBand).trim() !== "")
    ) {
      section("Age");
      const mult = pr.ageMultiplier ?? 1;
      rowFull(`Age adjustment (×${mult})`, pr.ageBand?.trim() || "—");
    }

    if (pr.pricingNote) {
      doc.fillColor("#b91c1c").fontSize(6.5).text(String(pr.pricingNote), left, y, { width: w });
      y = doc.y + 4;
      doc.fillColor("#000");
    }

    doc.font("Helvetica").fontSize(7.5).text(
      "This coverage entitles the holder to the following main benefits :",
      left,
      y,
      { width: w }
    );
    y = doc.y + 4;

    const groups = groupBenefits(payload.benefits);
    const catW = 22;
    const benW = w - catW - 52;
    const levW = 50;
    const tableRow = 10;

    if (!groups.length) {
      doc.fontSize(6.5).fillColor("#666").text("No benefit rows configured for this plan.", left, y);
      y = doc.y + 6;
    } else {
      doc.rect(left, y, w, tableRow).fill("#f5f5f5").strokeColor(GRAY_LINE).stroke();
      doc.fillColor("#000").font("Helvetica-Bold").fontSize(6);
      doc.text("Travel", left + 2, y + 3, { width: catW - 4 });
      doc.text("Benefits", left + catW + 2, y + 3, { width: benW - 4 });
      doc.text("Levels", left + catW + benW, y + 3, { width: levW - 4, align: "right" });
      y += tableRow;

      for (const g of groups) {
        const blockH = g.rows.length * tableRow;
        const yStart = y;
        doc.rect(left, yStart, catW, blockH).strokeColor(GRAY_LINE).stroke();
        doc.save();
        doc.translate(left + catW / 2, yStart + blockH / 2);
        doc.rotate(-90);
        doc.font("Helvetica-Bold").fontSize(6).fillColor("#000");
        doc.text(g.header, -blockH / 2 + 2, -3, {
          width: blockH - 4,
          align: "center"
        });
        doc.restore();

        let yr = yStart;
        for (const row of g.rows) {
          doc.rect(left + catW, yr, benW + levW, tableRow).strokeColor(GRAY_LINE).stroke();
          doc.fillColor("#000").font("Helvetica").fontSize(6);
          doc.text(String(row.benefit || "—"), left + catW + 3, yr + 2, { width: benW - 6, ellipsis: true });
          const lv = row.level != null && row.level !== "" ? String(row.level) : "—";
          doc.text(lv, left + catW + benW, yr + 2, {
            width: levW - 6,
            align: "right"
          });
          yr += tableRow;
        }
        y = yStart + blockH;
      }
    }

    y += 4;
    const contact = payload.contact || {};
    doc.font("Helvetica").fontSize(6.5).fillColor("#000");
    doc.text("Kindly contact immediately Assur'Assistance if you need any assistance on:", left, y, { width: w });
    y = doc.y + 2;
    const eh = contact.emergencyHelpline || "—";
    const gl = contact.generalLine || "—";
    const wa = contact.whatsapp || "—";
    const web = (contact.websiteUrl || "").replace(/^https?:\/\//i, "").replace(/\/$/, "") || "—";
    doc.text(`- Dedicated 24/7 Emergency Helpline : ${eh}`, left, y, { width: w });
    y = doc.y + 1;
    doc.text(`- General inquiries Line: ${gl}`, left, y, { width: w });
    y = doc.y + 1;
    doc.text(`- WhatsApp: ${wa}`, left, y, { width: w });
    y = doc.y + 1;
    doc.text(`- Our website: ${web}`, left, y, { width: w });
    y = doc.y + 6;

    doc.moveTo(left, y).lineTo(right, y).strokeColor(GRAY_LINE).lineWidth(0.5).stroke();
    y += 5;

    doc.font("Helvetica-Bold").fontSize(7);
    doc.text(`Certificate No: ${payload.certificateNumber}`, left, y);
    y += 9;
    doc.text(`Policy No: ${payload.policyNumber}`, left, y);
    y += 9;
    if (payload.invoiceNumber) {
      doc.text(`Invoice No: ${payload.invoiceNumber}`, left, y);
      y += 9;
    }

    const qrBuf = qrBufferFromDataUrl(payload.qrDataUrl);
    const qrSize = 56;
    const bottomBlockH = qrSize + 52;
    const pageBottom = doc.page.height - 24;
    if (y + bottomBlockH > pageBottom) {
      doc.addPage();
      y = 20;
    }

    doc.font("Helvetica").fontSize(6).fillColor("#000").text("Authentication Code ASSISTANCE", left, y);
    y += 8;
    if (qrBuf) {
      try {
        doc.image(qrBuf, left, y, { width: qrSize, height: qrSize });
      } catch {
        doc.rect(left, y, qrSize, qrSize).strokeColor(GRAY_LINE).stroke();
      }
    } else {
      doc.rect(left, y, qrSize, qrSize).strokeColor(GRAY_LINE).stroke();
    }

    doc.font("Helvetica-Bold").fontSize(7).text("FOR ASSUR", right - 72, y + qrSize / 2 - 4, {
      width: 72,
      align: "right"
    });

    y += qrSize + 6;
    doc.font("Helvetica").fontSize(7).text(
      `Issued on this ${payload.issuedOn} under the seal and authority of Assur Assistance.`,
      left,
      y,
      { width: w, align: "center" }
    );
    y = doc.y + 3;
    doc.fontSize(6).fillColor("#333").text(
      "This certificate is issued electronically and is valid without signature.",
      left,
      y,
      { width: w, align: "center" }
    );
    y = doc.y + 6;

    doc.fillColor(ORANGE).rect(left, y, w, 3).fill();
    y += 6;
    doc.fillColor("#444").fontSize(5.5).font("Helvetica");
    const foot =
      payload.footer?.line1 ||
      "ASSUR'ASSISTANCE SARL — Abidjan, Côte d'Ivoire — This certificate is issued electronically and is valid without signature.";
    doc.text(foot, left, y, { width: w, align: "center" });

    doc.end();
  });
}
