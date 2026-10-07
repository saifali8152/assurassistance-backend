/**
 * Certificate PDF matching the browser certificate print layout.
 * Compact single-page A4 for ZIP downloads and /sales/certificate/:id.
 *
 * BILINGUAL. The labels were hardcoded in English while the browser version was
 * fully translated, so a French customer's emailed certificate and the one they
 * printed from the portal did not match. Labels now come from CERT_I18N and the
 * locale is chosen by the caller, the same way the invoice PDF already did it.
 *
 * CHARACTER SAFETY. pdfkit's base-14 fonts encode WinAnsi (cp1252) and no font
 * is embedded. Today's French text happens to fit, but traveller names and
 * per-plan benefit labels are interpolated raw, so the first name containing a
 * character outside cp1252 — a Turkish ı, a Polish ł, anything Cyrillic — would
 * throw or mangle mid-render. `safeText` folds those to their closest Latin-1
 * equivalent so a certificate is always produced.
 */
import PDFDocument from "pdfkit";
import fs from "fs";
import path from "path";

const ORANGE = "#E4590F";

/** Labels, in the two languages the platform sells in. */
const CERT_I18N = {
  en: {
    docTitle: "Insurance certificate",
    certifies:
      "This is to certify that the insured has a valid travel insurance policy, providing coverage as detailed in the terms and conditions :",
    insured: "Insured",
    givenNames: "Given Names",
    surname: "Surname",
    dateOfBirth: "Date of Birth",
    gender: "Gender",
    nationality: "Nationality",
    residence: "Country of residence",
    period: "Period of stay",
    days: "N° Days",
    destinations: "Destination(s)",
    validity: "Validity (N° Days)",
    email: "Email",
    phone: "Phone Number",
    plan: "Plan",
    currency: "Currency",
    premium: "Premium",
    age: "Age",
    benefitsIntro: "This coverage entitles the holder to the following main benefits :",
    noBenefits: "No benefit rows configured for this plan.",
    colTravel: "Travel",
    colBenefits: "Benefits",
    colLevels: "Levels",
    contact: "Kindly contact immediately Assur'Assistance if you need any assistance on:",
    whatsapp: "WhatsApp",
    website: "Our website",
    certificateNo: "Certificate No",
    policyNo: "Policy No",
    invoiceNo: "Invoice No",
    worldwide: "Worldwide",
    footer:
      "This certificate is issued electronically and is valid without signature.",
  },
  fr: {
    docTitle: "Attestation d'assurance",
    certifies:
      "Nous certifions que l'assuré est titulaire d'une police d'assurance voyage en cours de validité, offrant les garanties détaillées dans les conditions générales :",
    insured: "Assuré",
    givenNames: "Prénoms",
    surname: "Nom",
    dateOfBirth: "Date de naissance",
    gender: "Sexe",
    nationality: "Nationalité",
    residence: "Pays de résidence",
    period: "Période de séjour",
    days: "N° de jours",
    destinations: "Destination(s)",
    validity: "Validité (N° de jours)",
    email: "E-mail",
    phone: "Téléphone",
    plan: "Formule",
    currency: "Devise",
    premium: "Prime",
    age: "Âge",
    benefitsIntro: "Cette couverture donne droit aux principales garanties suivantes :",
    noBenefits: "Aucune garantie configurée pour cette formule.",
    colTravel: "Voyage",
    colBenefits: "Garanties",
    colLevels: "Montants",
    contact: "Contactez immédiatement Assur'Assistance si vous avez besoin d'assistance :",
    whatsapp: "WhatsApp",
    website: "Notre site",
    certificateNo: "N° d'attestation",
    policyNo: "N° de police",
    invoiceNo: "N° de facture",
    worldwide: "Monde entier",
    footer:
      "Cette attestation est émise par voie électronique et est valable sans signature.",
  },
};

const labelsFor = (locale) => (String(locale).toLowerCase().startsWith("fr") ? CERT_I18N.fr : CERT_I18N.en);

/**
 * Fold anything pdfkit's WinAnsi encoding cannot represent.
 *
 * Without this a single character outside cp1252 in a traveller's name — which
 * we interpolate straight from the database — breaks the whole render. A folded
 * name is imperfect; a certificate that fails to generate is worse.
 */
const CP1252_FOLD = {
  "œ": "oe", "Œ": "OE", "ı": "i", "İ": "I", "ł": "l", "Ł": "L",
  "đ": "d", "Đ": "D", "ħ": "h", "ŋ": "n", "ŧ": "t", "ſ": "s",
  "–": "-", "—": "-", "‒": "-", "―": "-", "‘": "'", "’": "'",
  "“": '"', "”": '"', "„": '"', "…": "...", "′": "'", "″": '"',
  "≥": ">=", "≤": "<=", "≠": "!=", "→": "->", "←": "<-",
};

export function safeText(value) {
  if (value === null || value === undefined) return "";
  // Compose first, so "e" + combining acute becomes "é" — which cp1252 HAS and
  // we must not strip. Only what is still outside Latin-1 gets folded.
  let out = String(value).normalize("NFC");
  out = out.replace(/[^\u0000-\u00ff]/g, (ch) => {
    if (CP1252_FOLD[ch]) return CP1252_FOLD[ch];
    // A combining mark still here is one NFC could not attach to its letter —
    // "t" + combining acute has no precomposed form. Drop the mark and keep the
    // letter; replacing it with "?" would put a question mark mid-word.
    if (/[\u0300-\u036f]/.test(ch)) return "";
    const folded = ch.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    return /^[\u0000-\u00ff]*$/.test(folded) && folded ? folded : "?";
  });
  return out;
}

const GRAY_LINE = "#CCCCCC";

/** Accepts "#RRGGBB" or "#RRGGBBAA"; falls back to brand orange so old plans look the same. */
function sanitizeHexColor(input, fallback = ORANGE) {
  if (input == null) return fallback;
  const s = String(input).trim();
  return /^#([0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(s) ? s.toUpperCase() : fallback;
}

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
export function generateCertificatePdfFromPagePayload(payload, returnBuffer = true, options = {}) {
  // The locale is the caller's to choose: the browser page takes it from
  // ?lang=, the download endpoint from Accept-Language, and the WhatsApp
  // delivery from the conversation's own language.
  const L = labelsFor(options.locale || payload?.locale || "en");
  const doc = new PDFDocument({
    size: "A4",
    margin: 20,
    bufferPages: true,
    info: { Title: L.docTitle, Author: "Assur'Assistance" }
  });

  return new Promise((resolve, reject) => {
    const chunks = [];
    let stream;
    if (returnBuffer) {
      doc.on("data", (c) => chunks.push(c));
      doc.on("end", () => resolve(Buffer.concat(chunks)));
      doc.on("error", reject);
    } else {
      // NOT under uploads/, which is publicly served: a certificate number is
      // sequential and the document carries a passport number. utils/certificateStore.js
      // is the real writer; this branch exists for callers that want a file and
      // nothing more.
      const dir = path.join(process.cwd(), "storage", "certificates");
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const fileName = `${payload.certificateNumber}.pdf`;
      const filePath = path.join(dir, fileName);
      stream = fs.createWriteStream(filePath);
      doc.pipe(stream);
      stream.on("finish", () => resolve(`storage/certificates/${fileName}`));
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

    const partnerLogoPath =
      payload.partnerLogoFsPath && fs.existsSync(payload.partnerLogoFsPath)
        ? payload.partnerLogoFsPath
        : null;

    const headerH = 56;
    const mainLogoH = 50;
    const partnerLogoH = 48;
    const partnerFitW = 170;
    if (mainLogo) {
      try {
        doc.image(mainLogo, left, y, { height: mainLogoH, fit: [200, mainLogoH] });
      } catch {
        /* ignore */
      }
    }
    if (partnerLogoPath) {
      try {
        doc.image(partnerLogoPath, right - partnerFitW - 8, y + 1, {
          height: partnerLogoH,
          fit: [partnerFitW, partnerLogoH]
        });
      } catch {
        /* ignore */
      }
    }

    const themeColor = sanitizeHexColor(payload.themeColor);
    const extraIdFields = !!payload.extraIdFields;

    doc.fillColor(themeColor).font("Helvetica-Bold").fontSize(12);
    doc.text("INSURANCE CERTIFICATE", left, y + 10, {
      width: w,
      align: "center"
    });
    doc.fillColor("#000").font("Helvetica").fontSize(7.5);
    doc.text(productSubtitle(payload.productType), left, y + 28, { width: w, align: "center" });

    y += headerH;
    doc.fillColor(themeColor).rect(left, y, w, 2).fill();
    y += 8;

    doc.fillColor("#000").font("Helvetica").fontSize(7.5);
    doc.text(
      L.certifies,
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
      const rowStart = y;
      doc.font("Helvetica-Oblique").fontSize(6.5).fillColor("#333");
      doc.text(`${l1}:`, left, rowStart);
      doc.font("Helvetica-Bold").fillColor("#000");
      doc.text(v1s, left + 58, rowStart, { width: mid - left - 64, lineGap: 0.5 });
      const bottom1 = doc.y;
      doc.font("Helvetica-Oblique").fillColor("#333");
      doc.text(`${l2}:`, mid, rowStart);
      doc.font("Helvetica-Bold").fillColor("#000");
      doc.text(v2s, mid + 58, rowStart, { width: right - mid - 58, lineGap: 0.5 });
      const bottom2 = doc.y;
      y = Math.max(bottom1, bottom2, rowStart + rowH) + 2;
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
      doc.text((v1 || "—").toString(), left + 58, y, { width: w - 60, lineGap: 0.5 });
      y = doc.y + 2;
      doc
        .moveTo(left, y - 2)
        .lineTo(right, y - 2)
        .strokeColor(GRAY_LINE)
        .lineWidth(0.3)
        .stroke();
    }

    section(L.insured);
    const tr = payload.traveller || {};
    const idLabel = extraIdFields
      ? "N° Passport / N° Laissez-passer / N° GPGL"
      : "N° Passport";
    row2(L.givenNames, safeText(tr.givenNames).toUpperCase(), L.surname, safeText(tr.surname).toUpperCase());
    row2(L.dateOfBirth, safeText(tr.dateOfBirth), idLabel, safeText(tr.passportOrId));
    row2(L.gender, safeText(tr.gender), L.nationality, safeText(tr.nationality));
    rowFull(L.residence, safeText(tr.countryOfResidence));

    const scope = safeText((payload.coverage && payload.coverage.worldwideLabel) || L.worldwide);
    section(`Coverage Details – ${scope}`);
    const cov = payload.coverage || {};
    const period = `From ${cov.periodFrom || "—"} to ${cov.periodTo || "—"}`;
    row2(L.period, period, L.days, String(cov.stayDays ?? "—"));
    row2(
      L.destinations,
      (cov.destinations || "—").toString().toUpperCase(),
      L.validity,
      String(cov.validityDays ?? "—")
    );
    row2(L.email, safeText(cov.email), L.phone, safeText(cov.phone));
    row2(L.plan, safeText(cov.planName), L.currency, currencyLabel(cov.currency));

    const pr = payload.pricing || {};
    if (pr.showPremium) {
      const amount = Number(pr.planPremium) || 0;
      const cur = currencyLabel(cov.currency);
      rowFull(
        L.premium,
        `${amount.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 2 })} ${cur}`
      );
    }

    // Age band when non-standard (same rules for all plans, including Agico fixed-duration)
    if (
      (pr.ageMultiplier != null ||
        (pr.ageBand != null && String(pr.ageBand).trim() !== "")) &&
      pr.ageBand !== "standard" &&
      pr.ageBand !== "unknown"
    ) {
      section(L.age);
      const mult = pr.ageMultiplier ?? 1;
      rowFull(`Age adjustment (×${mult})`, pr.ageBand?.trim() || "—");
    }

    if (pr.pricingNote) {
      doc.fillColor("#b91c1c").fontSize(6.5).text(String(pr.pricingNote), left, y, { width: w });
      y = doc.y + 4;
      doc.fillColor("#000");
    }

    doc.font("Helvetica").fontSize(7.5).text(
      L.benefitsIntro,
      left,
      y,
      { width: w }
    );
    y = doc.y + 4;

    const groups = groupBenefits(payload.benefits);
    const catW = 26;
    const levW = 48;
    const benW = w - catW - levW;
    const tableRowMin = 12;

    if (!groups.length) {
      doc.fontSize(6.5).fillColor("#666").text(L.noBenefits, left, y);
      y = doc.y + 6;
    } else {
      doc.rect(left, y, w, tableRowMin).fill("#f5f5f5").strokeColor(GRAY_LINE).stroke();
      doc.fillColor("#000").font("Helvetica-Bold").fontSize(6);
      doc.text(L.colTravel, left + 2, y + 3, { width: catW - 4 });
      doc.text(L.colBenefits, left + catW + 2, y + 3, { width: benW - 4 });
      doc.text(L.colLevels, left + catW + benW, y + 3, { width: levW - 4, align: "right" });
      y += tableRowMin;

      for (const g of groups) {
        const rowHeights = g.rows.map((row) => {
          const benefitText = String(row.benefit || "—");
          doc.font("Helvetica").fontSize(6);
          const h = doc.heightOfString(benefitText, {
            width: benW - 6,
            lineGap: 0.5
          });
          return Math.max(tableRowMin, Math.ceil(h) + 5);
        });
        const blockH = rowHeights.reduce((a, b) => a + b, 0);
        const yStart = y;
        doc.rect(left, yStart, catW, blockH).strokeColor(GRAY_LINE).stroke();
        doc.save();
        doc.translate(left + catW / 2, yStart + blockH / 2);
        doc.rotate(-90);
        doc.font("Helvetica-Bold").fontSize(5.5).fillColor("#000");
        doc.text(g.header, -blockH / 2 + 2, -3, {
          width: blockH - 4,
          align: "center",
          lineGap: 0.5
        });
        doc.restore();

        let yr = yStart;
        g.rows.forEach((row, idx) => {
          const rh = rowHeights[idx];
          doc.rect(left + catW, yr, benW + levW, rh).strokeColor(GRAY_LINE).stroke();
          doc.fillColor("#000").font("Helvetica").fontSize(6);
          doc.text(String(row.benefit || "—"), left + catW + 3, yr + 2, {
            width: benW - 6,
            lineGap: 0.5
          });
          const lv = row.level != null && row.level !== "" ? String(row.level) : "—";
          doc.text(lv, left + catW + benW, yr + 2, {
            width: levW - 6,
            align: "right",
            lineGap: 0.5
          });
          yr += rh;
        });
        y = yStart + blockH;
      }
    }

    y += 4;
    const contact = payload.contact || {};
    doc.font("Helvetica").fontSize(6.5).fillColor("#000");
    doc.text(L.contact, left, y, { width: w });
    y = doc.y + 2;
    const eh = contact.emergencyHelpline || "—";
    const gl = contact.generalLine || "—";
    const ca = contact.centralAfricaLine || "—";
    const wa = contact.whatsapp || "—";
    const web = (contact.websiteUrl || "").replace(/^https?:\/\//i, "").replace(/\/$/, "") || "—";
    doc.text(`- Dedicated 24/7 Emergency Helpline : ${eh}`, left, y, { width: w });
    y = doc.y + 1;
    doc.text(`- General inquiries Line: ${gl}`, left, y, { width: w });
    y = doc.y + 1;
    doc.text(
      `- Central Africa platform (calls and WhatsApp): ${ca}`,
      left,
      y,
      { width: w }
    );
    y = doc.y + 1;
    doc.text(`- ${L.whatsapp}: ${safeText(wa)}`, left, y, { width: w });
    y = doc.y + 1;
    doc.text(`- ${L.website}: ${safeText(web)}`, left, y, { width: w });
    y = doc.y + 6;

    doc.moveTo(left, y).lineTo(right, y).strokeColor(GRAY_LINE).lineWidth(0.5).stroke();
    y += 5;

    doc.font("Helvetica-Bold").fontSize(7);
    doc.text(`${L.certificateNo}: ${payload.certificateNumber}`, left, y);
    y += 9;
    doc.text(`${L.policyNo}: ${payload.policyNumber}`, left, y);
    y += 9;
    if (payload.invoiceNumber) {
      doc.text(`${L.invoiceNo}: ${payload.invoiceNumber}`, left, y);
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

    doc.font("Helvetica-Bold").fontSize(7).text("Assur'Assistance", right - 100, y + qrSize / 2 - 6, {
      width: 100,
      align: "right"
    });

    y += qrSize + 6;
    doc.font("Helvetica").fontSize(7).text(
      `Issued on this ${payload.issuedOn} under the seal and authority of Assur'Assistance.`,
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

    doc.fillColor(themeColor).rect(left, y, w, 3).fill();
    y += 6;
    doc.fillColor("#444").fontSize(5.5).font("Helvetica");
    const foot =
      payload.footer?.line1 ||
      "ASSUR'ASSISTANCE SARL — Abidjan, Côte d'Ivoire — This certificate is issued electronically and is valid without signature.";
    doc.text(foot, left, y, { width: w, align: "center" });

    const wmLogo = tryImagePath(
      path.join(cwd, "public", "full-logo.png"),
      path.join(cwd, "..", "frontend", "public", "full-logo.png")
    );
    if (wmLogo) {
      try {
        const range = doc.bufferedPageRange();
        for (let i = range.start; i < range.start + range.count; i++) {
          doc.switchToPage(i);
          doc.save();
          doc.opacity(0.09);
          doc.image(wmLogo, doc.page.width - 128, doc.page.height - 118, {
            fit: [92, 92]
          });
          doc.restore();
          doc.opacity(1);
        }
      } catch (e) {
        console.error("Certificate watermark:", e?.message || e);
      }
    }

    doc.end();
  });
}
