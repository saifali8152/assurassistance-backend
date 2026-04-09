import { getInvoiceBySaleId } from "../models/invoiceModel.js";
import {
  getCertificateBySaleId,
  getCertificateByPublicToken,
  ensureCertificatePublicToken
} from "../models/certificateModel.js";
import { generateInvoicePDF } from "../utils/pdfGenerator.js";
import { generateCertificatePdfFromPagePayload } from "../utils/certificatePagePdf.js";
import { getCaseDetailsById } from "../models/caseModel.js";
import { getSaleById, getSalesByGroupIdForAgents } from "../models/salesModel.js";
import { findUserById, getAgentVisibilityIds } from "../models/userModel.js";
import archiver from "archiver";
import QRCode from "qrcode";
import {
  stayDaysToValidityTier,
  computeTravelPlanPremium
} from "../utils/travelPricing.js";
import path from "path";
import fs from "fs";

const DEFAULT_GENERAL_PHONE = (process.env.CERTIFICATE_GENERAL_PHONE || "+225 27 22 22 82 60").trim();
const DEFAULT_WHATSAPP_PHONE = (process.env.CERTIFICATE_WHATSAPP_PHONE || "+225 07 18 92 31 94").trim();

function resolvePublicUploadUrl(req, relativePath) {
  if (!relativePath || String(relativePath).trim() === "") return null;
  const p = String(relativePath).trim();
  if (/^https?:\/\//i.test(p)) return p;
  const envBase = (process.env.BASE_URL || "").replace(/\/$/, "");
  if (envBase) return `${envBase}${p.startsWith("/") ? "" : "/"}${p}`;
  const host = req.get("x-forwarded-host") || req.get("host") || "";
  const proto = req.get("x-forwarded-proto") || req.protocol || "https";
  if (!host) return p.startsWith("/") ? p : `/${p}`;
  return `${proto}://${host}${p.startsWith("/") ? "" : "/"}${p}`;
}

function partnerLogoFsFromDb(rel) {
  if (!rel || typeof rel !== "string" || !rel.startsWith("/uploads/")) return null;
  const fp = path.join(process.cwd(), rel.replace(/^\//, ""));
  try {
    return fs.existsSync(fp) ? fp : null;
  } catch {
    return null;
  }
}

/** Invoice amounts must use actual plan premium (plan_price), not sums of coverage limits. */
function invoiceBillableFromSale(sale, invoice) {
  const pp = Number(sale.plan_price);
  const taxV = Number(sale.tax != null ? sale.tax : invoice?.tax) || 0;
  if (Number.isFinite(pp) && pp > 0) {
    return { subtotal: pp, tax: taxV, total: pp + taxV };
  }
  const sub = Number(invoice?.subtotal ?? sale?.premium_amount) || 0;
  const tot = Number(invoice?.total ?? sale?.total) || 0;
  return { subtotal: sub, tax: taxV, total: tot };
}

function invoiceTitleFromReq(req) {
  if (!req?.get) return "INVOICE";
  const al = (req.get("Accept-Language") || "").toLowerCase();
  return al.startsWith("fr") ? "FACTURE" : "INVOICE";
}

/** "fr" | "en" — matches Accept-Language for invoice PDF copy */
function invoiceLocaleFromReq(req) {
  if (!req?.get) return "en";
  const al = (req.get("Accept-Language") || "").toLowerCase();
  return al.startsWith("fr") ? "fr" : "en";
}

const COVERAGE_LABELS = {
  medicalEmergencies: "Medical emergencies",
  medicalTransport: "Medical transport",
  hospitalization: "Hospitalization",
  evacuationRepatriation: "Evacuation / repatriation",
  bodyRepatriation: "Repatriation of remains",
  tripCancellation: "Trip cancellation",
  baggageDeliveryDelay: "Baggage / delivery delay",
  passportLoss: "Passport loss",
  civilLiability: "Civil liability",
  legalAssistance: "Legal assistance",
  bail: "Bail"
};

function categoryHeader(cat) {
  if (cat === "MEDICAL") return "MEDICAL";
  if (cat === "TRAVEL") return "TRIP PROTECTION";
  if (cat === "JURIDICAL") return "LEGAL";
  return cat;
}

function parsePricingRules(raw) {
  if (!raw) return null;
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }
  return raw;
}

function formatDateDMY(d) {
  if (!d) return "";
  const x = new Date(d);
  if (Number.isNaN(x.getTime())) return String(d);
  const dd = String(x.getDate()).padStart(2, "0");
  const mm = String(x.getMonth() + 1).padStart(2, "0");
  const yy = x.getFullYear();
  return `${dd}/${mm}/${yy}`;
}

/** Absolute URL for the public certificate page (QR). Set PUBLIC_CERTIFICATE_FRONTEND_URL or FRONTEND_URL in production if API and SPA use different hosts. */
/** Main agent = top of parent chain (supervisor); if no parent, the case creator. */
async function resolveMainAgentContact(createdByUserId) {
  if (!createdByUserId) {
    return { generalPhone: "", whatsapp: "" };
  }
  let current = await findUserById(createdByUserId);
  if (!current) return { generalPhone: "", whatsapp: "" };
  while (current.parent_agent_id) {
    const parent = await findUserById(current.parent_agent_id);
    if (!parent) break;
    current = parent;
  }
  return {
    generalPhone: current.work_phone ? String(current.work_phone).trim() : "",
    whatsapp: current.whatsapp_phone ? String(current.whatsapp_phone).trim() : ""
  };
}

function resolvePublicCertificateUrl(req, token) {
  const base = (process.env.PUBLIC_CERTIFICATE_FRONTEND_URL || process.env.FRONTEND_URL || "").trim();
  const path = `/certificate-public/${encodeURIComponent(token)}`;
  if (base) return `${base.replace(/\/$/, "")}${path}`;
  const proto = req.get("x-forwarded-proto") || req.protocol || "https";
  const host = req.get("x-forwarded-host") || req.get("host") || "";
  if (!host) return path;
  return `${proto}://${host}${path}`;
}

async function buildCertificatePagePayload(req, { cert, sale, caseDetails, invoice }) {
  let shareToken = cert.public_token;
  if (!shareToken) {
    shareToken = await ensureCertificatePublicToken(cert.id);
  }
  const publicViewUrl = resolvePublicCertificateUrl(req, shareToken);

  const pricingRules = parsePricingRules(caseDetails.pricing_rules);
  const stayDays = Number(caseDetails.duration_days) || 1;
  const validityDays = stayDaysToValidityTier(stayDays);

  let basePremium = null;
  let ageInfo = null;
  let computedPlanPremium = null;
  let pricingNote = null;

  const travelLike = ["Travel", "Travel Inbound", "Road travel"].includes(caseDetails.product_type);
  if (travelLike && pricingRules?.pricing?.length) {
    const comp = computeTravelPlanPremium(pricingRules, stayDays, caseDetails.date_of_birth);
    if (comp.error === "age_ineligible") {
      pricingNote = "Age over 85 — travel coverage not available under current rules.";
    } else if (comp.planPremium != null) {
      basePremium = comp.basePremium;
      ageInfo = comp.ageInfo;
      computedPlanPremium = comp.planPremium;
    }
  }

  const planPremiumDisplay =
    computedPlanPremium != null ? computedPlanPremium : Number(sale.plan_price) || 0;

  let guaranteesList = [];
  if (pricingRules?.guarantees?.length) {
    guaranteesList = pricingRules.guarantees.map((g) => ({
      category: g.category,
      categoryHeader: categoryHeader(g.category),
      coverageType: g.coverageType || null,
      benefit: COVERAGE_LABELS[g.coverageType] || g.coverageType || "—",
      level: g.amount != null && g.amount !== undefined ? g.amount : "—"
    }));
  } else {
    let gd = sale.guarantees_details;
    if (typeof gd === "string") {
      try {
        gd = JSON.parse(gd);
      } catch {
        gd = [];
      }
    }
    if (Array.isArray(gd)) {
        guaranteesList = gd.map((g) => ({
          category: g.category,
          categoryHeader: categoryHeader(g.category),
          coverageType: g.coverageType || null,
          benefit: COVERAGE_LABELS[g.coverageType] || g.coverageType || "—",
          level: g.amount != null ? g.amount : "—"
        }));
    }
  }

  let qrDataUrl = "";
  try {
    qrDataUrl = await QRCode.toDataURL(publicViewUrl, { width: 200, margin: 1, errorCorrectionLevel: "M" });
  } catch (e) {
    console.error("QR generation failed:", e);
  }

  const agentContact = await resolveMainAgentContact(caseDetails.created_by);
  const emergencyHelpline =
    (process.env.CERTIFICATE_EMERGENCY_PHONE || "+91 62916 62954").trim();
  const websiteUrl = (process.env.CERTIFICATE_WEBSITE_URL || "https://www.assurassistance.org").trim();
  const generalLine =
    agentContact.generalPhone && String(agentContact.generalPhone).trim() !== ""
      ? String(agentContact.generalPhone).trim()
      : DEFAULT_GENERAL_PHONE;
  const whatsappLine =
    agentContact.whatsapp && String(agentContact.whatsapp).trim() !== ""
      ? String(agentContact.whatsapp).trim()
      : DEFAULT_WHATSAPP_PHONE;

  const partnerRel = caseDetails.plan_partner_insurer_logo || null;

  return {
    certificateNumber: cert.certificate_number,
    policyNumber: sale.policy_number,
    invoiceNumber: invoice?.invoice_number || null,
    issuedOn: formatDateDMY(sale.confirmed_at || sale.created_at),
    productType: caseDetails.product_type,
    publicViewUrl,
    traveller: {
      givenNames: caseDetails.first_name || "",
      surname: caseDetails.last_name || "",
      fullName: caseDetails.full_name || "",
      dateOfBirth: formatDateDMY(caseDetails.date_of_birth),
      passportOrId: caseDetails.passport_or_id || "",
      gender: caseDetails.gender || "",
      nationality: caseDetails.nationality || "",
      countryOfResidence: caseDetails.country_of_residence || ""
    },
    coverage: {
      periodFrom: formatDateDMY(caseDetails.start_date),
      periodTo: formatDateDMY(caseDetails.end_date),
      stayDays,
      validityDays,
      destinations: caseDetails.destination || "",
      email: caseDetails.email || "",
      phone: caseDetails.phone || "",
      planName: caseDetails.plan_name || "",
      currency: sale.currency || caseDetails.currency || "XOF",
      worldwideLabel: "Worldwide"
    },
    pricing: {
      basePremium,
      ageBand: ageInfo?.band || null,
      ageMultiplier: ageInfo?.multiplier ?? null,
      planPremium: planPremiumDisplay,
      guaranteesTotal: Number(sale.guarantees_total) || 0,
      premiumAmount: Number(sale.premium_amount) || 0,
      tax: Number(sale.tax) || 0,
      total: Number(sale.total) || 0,
      storedPlanPrice: Number(sale.plan_price) || 0,
      pricingNote
    },
    benefits: guaranteesList,
    qrDataUrl,
    partnerLogoUrl: resolvePublicUploadUrl(req, partnerRel),
    partnerLogoFsPath: partnerLogoFsFromDb(partnerRel),
    contact: {
      emergencyHelpline,
      generalLine,
      whatsapp: whatsappLine,
      websiteUrl
    },
    footer: {
      line1:
        "ASSUR'ASSISTANCE SARL — Abidjan, Côte d'Ivoire — This certificate is issued electronically and is valid without signature."
    }
  };
}

/**
 * JSON payload for the printable certificate page (browser print → PDF). Authenticated.
 */
export const getCertificatePageData = async (req, res) => {
  try {
    const saleId = req.params.id;
    const cert = await getCertificateBySaleId(saleId);
    if (!cert) {
      return res.status(404).json({ message: "Certificate not found" });
    }

    const sale = await getSaleById(cert.sale_id);
    if (!sale) {
      return res.status(404).json({ message: "Sale not found" });
    }

    const caseDetails = await getCaseDetailsById(sale.case_id);
    if (!caseDetails) {
      return res.status(404).json({ message: "Case not found" });
    }

    const invoice = await getInvoiceBySaleId(saleId);
    const payload = await buildCertificatePagePayload(req, { cert, sale, caseDetails, invoice });
    res.json(payload);
  } catch (err) {
    console.error("Error building certificate page data:", err);
    res.status(500).json({ message: "Server error" });
  }
};

/**
 * Same JSON as /certificate/:id/page — no auth; lookup by certificates.public_token (QR).
 */
export const getCertificatePageDataPublic = async (req, res) => {
  try {
    const token = req.params.token;
    const cert = await getCertificateByPublicToken(token);
    if (!cert) {
      return res.status(404).json({ message: "Certificate not found" });
    }

    const sale = await getSaleById(cert.sale_id);
    if (!sale) {
      return res.status(404).json({ message: "Sale not found" });
    }

    const caseDetails = await getCaseDetailsById(sale.case_id);
    if (!caseDetails) {
      return res.status(404).json({ message: "Case not found" });
    }

    const invoice = await getInvoiceBySaleId(sale.id);
    const payload = await buildCertificatePagePayload(req, { cert, sale, caseDetails, invoice });
    res.json(payload);
  } catch (err) {
    console.error("Error building public certificate page data:", err);
    res.status(500).json({ message: "Server error" });
  }
};

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
      address: caseDetails.address,
      country_of_residence: caseDetails.country_of_residence || null
    };

    const plan = {
      id: caseDetails.plan_id,
      name: caseDetails.plan_name,
      product_type: caseDetails.product_type,
      coverage: caseDetails.coverage,
      flat_price: caseDetails.flat_price
    };

    const sale = saleDetails;
    const bill = invoiceBillableFromSale(sale, invoice);
    const partnerFs = partnerLogoFsFromDb(caseDetails.plan_partner_insurer_logo);

    const pdfBuffer = await generateInvoicePDF(
      {
        invoiceNumber: invoice.invoice_number,
        sale,
        traveller,
        plan,
        subtotal: bill.subtotal,
        tax: bill.tax,
        total: bill.total,
        countryOfResidence: traveller.country_of_residence,
        partnerLogoFsPath: partnerFs,
        invoiceTitle: invoiceTitleFromReq(req),
        currency: sale.currency || "XOF",
        locale: invoiceLocaleFromReq(req)
      },
      true
    );

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

/** PDF buffer for a sale id — same layout as printable certificate page */
async function certificatePdfBufferForSaleId(saleId, req) {
  const cert = await getCertificateBySaleId(saleId);
  if (!cert) return null;

  const saleDetails = await getSaleById(cert.sale_id);
  if (!saleDetails) return null;

  const caseDetails = await getCaseDetailsById(saleDetails.case_id);
  if (!caseDetails) return null;

  const invoice = await getInvoiceBySaleId(saleId);
  const payload = await buildCertificatePagePayload(req, {
    cert,
    sale: saleDetails,
    caseDetails,
    invoice
  });
  const pdfBuffer = await generateCertificatePdfFromPagePayload(payload, true);
  return { pdfBuffer, certificate_number: cert.certificate_number };
}

/** Invoice PDF buffer for a sale id (group ZIP) */
async function invoicePdfBufferForSaleId(saleId, req) {
  const invoice = await getInvoiceBySaleId(saleId);
  if (!invoice) return null;

  const saleDetails = await getSaleById(invoice.sale_id);
  if (!saleDetails) return null;

  const caseDetails = await getCaseDetailsById(saleDetails.case_id);
  if (!caseDetails) return null;

  const traveller = {
    full_name: caseDetails.full_name,
    phone: caseDetails.phone,
    email: caseDetails.email,
    passport_or_id: caseDetails.passport_or_id,
    address: caseDetails.address,
    country_of_residence: caseDetails.country_of_residence || null
  };

  const plan = {
    id: caseDetails.plan_id,
    name: caseDetails.plan_name,
    product_type: caseDetails.product_type,
    coverage: caseDetails.coverage,
    flat_price: caseDetails.flat_price
  };

  const bill = invoiceBillableFromSale(saleDetails, invoice);
  const partnerFs = partnerLogoFsFromDb(caseDetails.plan_partner_insurer_logo);

  const pdfBuffer = await generateInvoicePDF(
    {
      invoiceNumber: invoice.invoice_number,
      sale: saleDetails,
      traveller,
      plan,
      subtotal: bill.subtotal,
      tax: bill.tax,
      total: bill.total,
      countryOfResidence: traveller.country_of_residence,
      partnerLogoFsPath: partnerFs,
      invoiceTitle: invoiceTitleFromReq(req),
      currency: saleDetails.currency || "XOF",
      locale: invoiceLocaleFromReq(req)
    },
    true
  );
  return { pdfBuffer, invoice_number: invoice.invoice_number };
}

export const downloadCertificate = async (req, res) => {
  try {
    const saleId = req.params.id;
    const result = await certificatePdfBufferForSaleId(saleId, req);
    if (!result) {
      return res.status(404).json({ message: "Certificate not found" });
    }
    const { pdfBuffer, certificate_number } = result;
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="certificate-${certificate_number}.pdf"`);
    res.setHeader("Content-Length", pdfBuffer.length);
    res.send(pdfBuffer);
  } catch (err) {
    console.error("Error downloading certificate:", err);
    res.status(500).json({ message: "Server error" });
  }
};

/** ZIP of all certificate PDFs for a group subscription (cases.group_id) */
export const downloadGroupCertificatesZip = async (req, res) => {
  try {
    const { groupId } = req.params;
    if (!groupId?.trim()) {
      return res.status(400).json({ message: "Invalid group id" });
    }
    const agentIds = await getAgentVisibilityIds(req.user.id);
    const salesRows = await getSalesByGroupIdForAgents(groupId.trim(), agentIds);
    if (!salesRows.length) {
      return res.status(404).json({ message: "No certificates found for this group" });
    }

    const archive = archiver("zip", { zlib: { level: 9 } });
    archive.on("error", (err) => {
      console.error("ZIP archive error:", err);
      if (!res.headersSent) res.status(500).end();
    });

    res.setHeader("Content-Type", "application/zip");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="certificates-group-${encodeURIComponent(groupId)}.zip"`
    );
    archive.pipe(res);

    for (const row of salesRows) {
      const result = await certificatePdfBufferForSaleId(row.sale_id, req);
      if (result) {
        archive.append(result.pdfBuffer, {
          name: `certificate-${result.certificate_number}.pdf`
        });
      }
    }
    await archive.finalize();
  } catch (err) {
    console.error("Error downloading group certificates:", err);
    if (!res.headersSent) res.status(500).json({ message: "Server error" });
  }
};

/** ZIP of all invoice PDFs for a group subscription */
export const downloadGroupInvoicesZip = async (req, res) => {
  try {
    const { groupId } = req.params;
    if (!groupId?.trim()) {
      return res.status(400).json({ message: "Invalid group id" });
    }
    const agentIds = await getAgentVisibilityIds(req.user.id);
    const salesRows = await getSalesByGroupIdForAgents(groupId.trim(), agentIds);
    if (!salesRows.length) {
      return res.status(404).json({ message: "No sales found for this group" });
    }

    const archive = archiver("zip", { zlib: { level: 9 } });
    archive.on("error", (err) => {
      console.error("ZIP archive error:", err);
      if (!res.headersSent) res.status(500).end();
    });

    res.setHeader("Content-Type", "application/zip");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="invoices-group-${encodeURIComponent(groupId)}.zip"`
    );
    archive.pipe(res);

    for (const row of salesRows) {
      const inv = await invoicePdfBufferForSaleId(row.sale_id, req);
      if (inv) {
        archive.append(inv.pdfBuffer, {
          name: `invoice-${inv.invoice_number}.pdf`
        });
      }
    }
    await archive.finalize();
  } catch (err) {
    console.error("Error downloading group invoices:", err);
    if (!res.headersSent) res.status(500).json({ message: "Server error" });
  }
};
