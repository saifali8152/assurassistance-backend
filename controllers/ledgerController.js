// src/controllers/ledgerController.js
import { getLedger, getLedgerSummary } from "../models/ledgerModel.js";
import { format } from "@fast-csv/format";

async function resolveVisibility(req) {
  const role = req.user.role;
  let agentIds = null;
  let partnerInsurer = null;
  if (role === "agent" || role === "sub_admin") {
    const { getAgentVisibilityIds } = await import("../models/userModel.js");
    agentIds = await getAgentVisibilityIds(req.user.id);
  }
  if (role === "insurer_supervisor") {
    const { findUserById } = await import("../models/userModel.js");
    const u = await findUserById(req.user.id);
    partnerInsurer = u?.partner_insurer || null;
  }
  return { role, agentId: req.user.id, agentIds, partnerInsurer };
}

export const listLedger = async (req, res) => {
  try {
    const { role, agentId, agentIds, partnerInsurer } = await resolveVisibility(req);
    const {
      startDate,
      endDate,
      status,
      paymentStatus,
      search,
      page = 1,
      limit = 25,
    } = req.query;

    const filters = {
      role,
      agentId,
      agentIds,
      partnerInsurer,
      startDate,
      endDate,
      status,
      paymentStatus,
      search,
    };

    const [result, summary] = await Promise.all([
      getLedger({ ...filters, page, limit }),
      getLedgerSummary(filters),
    ]);

    res.json({
      success: true,
      data: result.rows,
      meta: {
        total: result.total,
        page: result.page,
        limit: result.limit,
        summary,
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Server error" });
  }
};

export const exportLedgerCsv = async (req, res) => {
  try {
    const { role, agentId, agentIds, partnerInsurer } = await resolveVisibility(req);
    const { startDate, endDate, status, paymentStatus, search } = req.query;

    const filters = {
      role,
      agentId,
      agentIds,
      partnerInsurer,
      startDate,
      endDate,
      status,
      paymentStatus,
      search,
    };

    const [result, summary] = await Promise.all([
      getLedger({ ...filters, page: 1, limit: 1000000 }),
      getLedgerSummary(filters),
    ]);

    const fileName = `sales_ledger_${Date.now()}.csv`;
    res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.write("\uFEFF"); // BOM for Excel

    const csvStream = format({ headers: true, quoteColumns: true });
    csvStream.pipe(res);

    result.rows.forEach((r) => {
      csvStream.write({
        "Sale ID": r.sale_id,
        "Case ID": r.case_id,
        "Last Name": r.last_name || "",
        "First Name": r.first_name || "",
        "Date of Birth": r.date_of_birth || "",
        "Traveller Phone": r.traveller_phone || "",
        Destination: r.destination || "",
        "Travel Start": r.start_date || "",
        "Travel End": r.end_date || "",
        "Duration (days)": r.duration_days ?? "",
        "Plan Name": r.plan_name || "",
        "Product Type": r.product_type || "",
        "Policy Number": r.policy_number || "",
        "Certificate Number": r.certificate_number || "",
        "Premium": r.plan_premium || 0,
        Tax: r.tax || 0,
        "Premium including tax": r.premium_including_tax ?? r.total ?? 0,
        "Agency Commission": r.agency_commission ?? r.commission ?? 0,
        "Net to be transferred": r.net_to_transfer || 0,
        Currency: r.currency || "XOF",
        "Received Amount": r.received_amount || 0,
        "Payment Status": r.payment_status || "",
        "Confirmed At": r.confirmed_at ? new Date(r.confirmed_at).toLocaleString() : "",
        "Created By": r.created_by_name || "",
        "Payment Notes": r.payment_notes || "",
      });
    });

    // Summary footer rows (same labels as partner invoice consolidation)
    csvStream.write({
      "Sale ID": "",
      "Case ID": "",
      "Last Name": "",
      "First Name": "",
      "Date of Birth": "",
      "Traveller Phone": "",
      Destination: "",
      "Travel Start": "",
      "Travel End": "",
      "Duration (days)": "",
      "Plan Name": "SUMMARY",
      "Product Type": "",
      "Policy Number": "",
      "Certificate Number": "",
      Premium: "",
      Tax: "",
      "Premium including tax": summary.totalPremiums,
      "Agency Commission": summary.totalCommissions,
      "Net to be transferred": summary.netToTransfer,
      Currency: "",
      "Received Amount": summary.totalCollected,
      "Payment Status": `Policies: ${summary.totalPolicies}`,
      "Confirmed At": "",
      "Created By": "",
      "Payment Notes": "",
    });

    csvStream.end();
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Server error" });
  }
};
