import { getInvoiceBySaleId } from "../models/invoiceModel.js";
import { getCertificateBySaleId } from "../models/certificateModel.js";
import { generateInvoicePDF, generateCertificatePDF } from "../utils/pdfGenerator.js";
import { getCaseDetailsById } from "../models/caseModel.js";
import { getSaleById } from "../models/salesModel.js";
import QRCode from "qrcode";
import {
  stayDaysToValidityTier,
  computeTravelPlanPremium
} from "../utils/travelPricing.js";

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

/**
 * JSON payload for the printable certificate page (browser print → PDF).
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
          benefit: COVERAGE_LABELS[g.coverageType] || g.coverageType || "—",
          level: g.amount != null ? g.amount : "—"
        }));
      }
    }

    const verifyPayload = JSON.stringify({
      cert: cert.certificate_number,
      pol: sale.policy_number,
      sale: sale.id
    });
    let qrDataUrl = "";
    try {
      qrDataUrl = await QRCode.toDataURL(verifyPayload, { width: 160, margin: 1 });
    } catch (e) {
      console.error("QR generation failed:", e);
    }

    res.json({
      certificateNumber: cert.certificate_number,
      policyNumber: sale.policy_number,
      invoiceNumber: invoice?.invoice_number || null,
      issuedOn: formatDateDMY(sale.confirmed_at || sale.created_at),
      productType: caseDetails.product_type,
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
      footer: {
        line1:
          "ASSUR'ASSISTANCE SARL — Abidjan, Côte d'Ivoire — This certificate is issued electronically and is valid without signature."
      }
    });
  } catch (err) {
    console.error("Error building certificate page data:", err);
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

    // Generate PDF buffer (without saving to file)
    const pdfBuffer = await generateInvoicePDF({
      invoiceNumber: invoice.invoice_number,
      sale,
      traveller,
      plan,
      subtotal: invoice.subtotal,
      tax: invoice.tax,
      total: invoice.total,
      countryOfResidence: traveller.country_of_residence
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

    // Parse guarantees_details (benefits table) for certificate
    let guaranteesDetails = sale.guarantees_details;
    if (typeof guaranteesDetails === 'string') {
      try {
        guaranteesDetails = JSON.parse(guaranteesDetails);
      } catch (e) {
        guaranteesDetails = null;
      }
    }
    if (!Array.isArray(guaranteesDetails)) guaranteesDetails = [];

    // Generate PDF buffer (without saving to file)
    const pdfBuffer = await generateCertificatePDF({
      certificateNumber: cert.certificate_number,
      sale,
      traveller,
      plan,
      productType: plan.product_type,
      countryOfResidence: traveller.country_of_residence,
      guaranteesDetails
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
