import path from "path";
import getPool from "../utils/db.js";
import { getAllDescendantIds, getOwnedAgencyIds, getAgentVisibilityIds } from "../models/userModel.js";
import {
  getPartnerSalesForPeriod,
  getCommissionSummary,
  computeInvoiceTotals,
} from "../models/partnerInvoiceModel.js";
import { generatePartnerInvoicePDF } from "../utils/partnerInvoicePdf.js";
import { COMMISSION_TIERS } from "../utils/commissionRules.js";
import { normalizeCurrency } from "../utils/currencyDisplay.js";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function parsePeriod(req) {
  const { startDate, endDate } = req.query;
  if (!startDate || !endDate || !DATE_RE.test(startDate) || !DATE_RE.test(endDate)) {
    return null;
  }
  if (startDate > endDate) return null;
  return { startDate, endDate };
}

/** Optional invoice options: selected sale ids + percentage discount (0–100). */
function parseInvoiceOptions(req) {
  let discountPct = Number(req.query.discountPct);
  if (!Number.isFinite(discountPct) || discountPct < 0) discountPct = 0;
  if (discountPct > 100) discountPct = 100;

  let saleIds = null;
  const raw = req.query.saleIds;
  if (raw != null && String(raw).trim() !== "") {
    saleIds = String(raw)
      .split(",")
      .map((s) => Number(String(s).trim()))
      .filter((n) => Number.isInteger(n) && n > 0);
  } else if (raw != null && String(raw).trim() === "") {
    saleIds = [];
  }
  return { discountPct, saleIds };
}

function localeFromReq(req) {
  const al = (req.get("Accept-Language") || "").toLowerCase();
  return al.startsWith("fr") ? "fr" : "en";
}

function currencyFromReq(req) {
  return normalizeCurrency(req.query.currency);
}

function partnerLogoFsFromDb(rel) {
  if (!rel || typeof rel !== "string" || !rel.startsWith("/uploads/")) return null;
  return path.join(process.cwd(), rel.replace(/^\//, ""));
}

/**
 * Load the partner (top-level agency) and enforce access:
 * admins may invoice any top-level partner; sub-admins only agencies they created.
 * Returns { partner } or { error: { status, message } }.
 */
async function resolvePartner(req, partnerId) {
  const id = Number(partnerId);
  if (!Number.isInteger(id) || id <= 0) {
    return { error: { status: 400, message: "Invalid partner id" } };
  }

  const pool = getPool();
  const [rows] = await pool.query(
    `SELECT id, name, email, company_name, partnership_type, geographical_location,
            work_phone, whatsapp_phone, created_by_id
     FROM users
     WHERE id = ? AND role = 'agent' AND (parent_agent_id IS NULL OR parent_agent_id = 0)`,
    [id]
  );
  if (!rows.length) {
    return { error: { status: 404, message: "Partner not found" } };
  }

  if (req.user.role === "sub_admin") {
    const ownedIds = await getOwnedAgencyIds(req.user.id);
    if (!ownedIds.includes(id)) {
      return { error: { status: 403, message: "This partner is not under your supervision" } };
    }
  }
  return { partner: rows[0] };
}

async function loadInvoiceData(partner, startDate, endDate, { saleIds = null, discountPct = 0 } = {}) {
  const accountIds = [partner.id, ...(await getAllDescendantIds(partner.id))];
  let lines = await getPartnerSalesForPeriod({ accountIds, startDate, endDate });
  if (saleIds != null) {
    const allowed = new Set(saleIds);
    lines = lines.filter((l) => allowed.has(l.sale_id));
  }
  return { lines, totals: computeInvoiceTotals(lines, { discountPct }) };
}

function buildInvoiceNumber(partner, startDate) {
  const slug = String(partner.company_name || partner.name || `partner-${partner.id}`)
    .trim()
    .replace(/\s+/g, "-");
  return `INV ${slug} _ ${startDate.slice(0, 7).replace("-", "")}`;
}

/**
 * GET /api/partner-invoices/partners
 * Partners selectable for invoicing (admin: all top-level agencies; sub-admin: owned ones).
 */
export const listInvoicePartners = async (req, res) => {
  try {
    const pool = getPool();
    const params = [];
    let ownershipClause = "";
    if (req.user.role === "sub_admin") {
      ownershipClause = " AND u.created_by_id = ?";
      params.push(req.user.id);
    }
    const [rows] = await pool.query(
      `SELECT u.id, u.name, u.email, u.company_name, u.partnership_type
       FROM users u
       WHERE u.role = 'agent' AND (u.parent_agent_id IS NULL OR u.parent_agent_id = 0)
         ${ownershipClause}
       ORDER BY u.company_name IS NULL, u.company_name ASC, u.name ASC`,
      params
    );
    res.json({ success: true, data: rows });
  } catch (err) {
    console.error("Error listing invoice partners:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
};

/**
 * GET /api/partner-invoices/summary?startDate&endDate
 * Dashboard reminder: total premiums, premiums collected, commissions for the period,
 * scoped to the caller's visibility (admin sees everything).
 */
export const getPartnerInvoiceSummary = async (req, res) => {
  try {
    const period = parsePeriod(req);
    if (!period) {
      return res.status(400).json({ success: false, message: "startDate and endDate (YYYY-MM-DD) are required" });
    }
    let accountIds = null;
    if (req.user.role !== "admin") {
      accountIds = await getAgentVisibilityIds(req.user.id);
    }
    const summary = await getCommissionSummary({ accountIds, ...period });
    res.json({ success: true, data: { ...summary, ...period } });
  } catch (err) {
    console.error("Error building partner invoice summary:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
};

/**
 * GET /api/partner-invoices/:partnerId?startDate&endDate
 * JSON preview of the invoice: line items with commissions and totals.
 */
export const getPartnerInvoice = async (req, res) => {
  try {
    const period = parsePeriod(req);
    if (!period) {
      return res.status(400).json({ success: false, message: "startDate and endDate (YYYY-MM-DD) are required" });
    }
    const { partner, error } = await resolvePartner(req, req.params.partnerId);
    if (error) return res.status(error.status).json({ success: false, message: error.message });

    const options = parseInvoiceOptions(req);
    const { lines, totals } = await loadInvoiceData(partner, period.startDate, period.endDate, options);
    res.json({
      success: true,
      data: {
        invoiceNumber: buildInvoiceNumber(partner, period.startDate),
        partner: {
          id: partner.id,
          name: partner.name,
          company_name: partner.company_name,
          partnership_type: partner.partnership_type,
          address: partner.geographical_location,
          phone: partner.work_phone || partner.whatsapp_phone,
          email: partner.email,
        },
        period,
        commissionTiers: COMMISSION_TIERS,
        lines,
        totals,
      },
    });
  } catch (err) {
    console.error("Error building partner invoice:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
};

/**
 * GET /api/partner-invoices/:partnerId/pdf?startDate&endDate
 * The invoice PDF in the official format (logos, addresses, premium breakdown,
 * commissions deducted from the total premium).
 */
export const downloadPartnerInvoicePdf = async (req, res) => {
  try {
    const period = parsePeriod(req);
    if (!period) {
      return res.status(400).json({ success: false, message: "startDate and endDate (YYYY-MM-DD) are required" });
    }
    const { partner, error } = await resolvePartner(req, req.params.partnerId);
    if (error) return res.status(error.status).json({ success: false, message: error.message });

    const options = parseInvoiceOptions(req);
    const { lines, totals } = await loadInvoiceData(partner, period.startDate, period.endDate, options);
    const insurerLogoRel = lines.find((l) => l.partner_insurer_logo)?.partner_insurer_logo || null;
    const invoiceNumber = buildInvoiceNumber(partner, period.startDate);

    const pdfBuffer = await generatePartnerInvoicePDF({
      invoiceNumber,
      partner,
      lines,
      totals,
      startDate: period.startDate,
      endDate: period.endDate,
      partnerLogoFsPath: partnerLogoFsFromDb(insurerLogoRel),
      locale: localeFromReq(req),
      currency: currencyFromReq(req),
    });

    const fileSlug = invoiceNumber.replace(/[^\w-]+/g, "-").replace(/-+/g, "-");
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${fileSlug}.pdf"`);
    res.setHeader("Content-Length", pdfBuffer.length);
    res.send(pdfBuffer);
  } catch (err) {
    console.error("Error generating partner invoice PDF:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
};
