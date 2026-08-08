// src/controllers/ledgerController.js
import { getLedger, getLedgerSummary } from "../models/ledgerModel.js";
import { format } from "@fast-csv/format";

async function resolveVisibility(req) {
  const role = req.user.role;
  let agentIds = null;
  if (role === "agent" || role === "sub_admin") {
    const { getAgentVisibilityIds } = await import("../models/userModel.js");
    agentIds = await getAgentVisibilityIds(req.user.id);
  }
  return { role, agentId: req.user.id, agentIds };
}

export const listLedger = async (req, res) => {
  try {
    const { role, agentId, agentIds } = await resolveVisibility(req);
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
    const { role, agentId, agentIds } = await resolveVisibility(req);
    const { startDate, endDate, status, paymentStatus, search } = req.query;

    const filters = {
      role,
      agentId,
      agentIds,
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
        "Traveller Name": r.traveller_name || "",
        "Traveller Phone": r.traveller_phone || "",
        "Plan Name": r.plan_name || "",
        "Product Type": r.product_type || "",
        "Policy Number": r.policy_number || "",
        "Certificate Number": r.certificate_number || "",
        "Plan premium (rate)": r.plan_premium || 0,
        Tax: r.tax || 0,
        Total: r.total || 0,
        Commission: r.commission || 0,
        "Net to transfer": r.net_to_transfer || 0,
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
      "Traveller Name": "",
      "Traveller Phone": "",
      "Plan Name": "SUMMARY",
      "Product Type": "",
      "Policy Number": "",
      "Certificate Number": "",
      "Plan premium (rate)": "",
      Tax: "",
      Total: summary.totalPremiums,
      Commission: summary.totalCommissions,
      "Net to transfer": summary.netToTransfer,
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
