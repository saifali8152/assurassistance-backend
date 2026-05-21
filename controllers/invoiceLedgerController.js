// src/controllers/invoiceLedgerController.js
//
// Paginated invoice listing grouped/filterable by region. Role-scoped exactly like
// the Sales Ledger:
//   - admin     → unrestricted (sees every invoice)
//   - sub_admin → invoices for cases under agencies they created (+ descendants)
//   - agent     → invoices for their own + sub-agents' cases
//
// `regionBy` selects which column drives the "region" dimension:
//   residence (default) | destination | agent
//
import { format } from "@fast-csv/format";
import { getInvoiceLedger, getInvoiceRegionSummary, getInvoiceLedgerAll } from "../models/invoiceLedgerModel.js";

const VALID_REGION_BYS = new Set(["residence", "destination", "agent"]);

function normalizeRegionBy(raw) {
  if (!raw) return "residence";
  const s = String(raw).trim().toLowerCase();
  return VALID_REGION_BYS.has(s) ? s : "residence";
}

async function resolveAgentIds(req) {
  if (req.user.role === "admin") return null;
  const { getAgentVisibilityIds } = await import("../models/userModel.js");
  return getAgentVisibilityIds(req.user.id);
}

/** GET /api/invoice-ledger */
export const listInvoiceLedger = async (req, res) => {
  try {
    const role = req.user.role;
    const agentId = req.user.id;
    const agentIds = await resolveAgentIds(req);

    const {
      startDate,
      endDate,
      paymentStatus,
      region,
      regionBy: rawRegionBy,
      search,
      page = 1,
      limit = 25
    } = req.query;

    const regionBy = normalizeRegionBy(rawRegionBy);
    const opts = {
      role,
      agentId,
      agentIds,
      startDate,
      endDate,
      paymentStatus,
      region,
      regionBy,
      search,
      page,
      limit
    };

    const [pageResult, summary] = await Promise.all([
      getInvoiceLedger(opts),
      getInvoiceRegionSummary({ ...opts, topN: 50 })
    ]);

    res.json({
      success: true,
      data: pageResult.rows,
      meta: {
        total: pageResult.total,
        page: pageResult.page,
        limit: pageResult.limit,
        regionBy: pageResult.regionBy
      },
      regionSummary: summary
    });
  } catch (err) {
    console.error("listInvoiceLedger:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
};

/** GET /api/invoice-ledger/export */
export const exportInvoiceLedgerCsv = async (req, res) => {
  try {
    const role = req.user.role;
    const agentId = req.user.id;
    const agentIds = await resolveAgentIds(req);

    const {
      startDate,
      endDate,
      paymentStatus,
      region,
      regionBy: rawRegionBy,
      search
    } = req.query;

    const regionBy = normalizeRegionBy(rawRegionBy);

    const rows = await getInvoiceLedgerAll({
      role,
      agentId,
      agentIds,
      startDate,
      endDate,
      paymentStatus,
      region,
      regionBy,
      search
    });

    const fileName = `invoices_by_region_${Date.now()}.csv`;
    res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.write("\uFEFF"); // BOM for Excel

    const csvStream = format({ headers: true, quoteColumns: true });
    csvStream.pipe(res);

    rows.forEach((r) => {
      csvStream.write({
        Region: r.region || "",
        "Invoice Number": r.invoice_number || "",
        "Issue Date": r.issue_date ? new Date(r.issue_date).toISOString() : "",
        "Traveller": r.traveller_name || "",
        "Traveller Country": r.traveller_country || "",
        "Destination": r.destination || "",
        "Plan Name": r.plan_name || "",
        "Product Type": r.product_type || "",
        "Policy Number": r.policy_number || "",
        "Certificate Number": r.certificate_number || "",
        Subtotal: r.subtotal ?? 0,
        Tax: r.tax ?? 0,
        Total: r.total ?? 0,
        "Received Amount": r.received_amount ?? 0,
        "Payment Status": r.payment_status || "",
        Currency: r.currency || "XOF",
        "Created By": r.created_by_name || "",
        "Agent Country": r.agent_country || "",
        "Agent Geo": r.agent_geo || "",
        "Sale ID": r.sale_id,
        "Case ID": r.case_id,
        "Confirmed At": r.confirmed_at ? new Date(r.confirmed_at).toISOString() : "",
        "Coverage Start": r.start_date || "",
        "Coverage End": r.end_date || ""
      });
    });

    csvStream.end();
  } catch (err) {
    console.error("exportInvoiceLedgerCsv:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
};
