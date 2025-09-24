// src/controllers/ledgerController.js
import { getLedger } from "../models/ledgerModel.js";
import { getInvoiceBySaleId } from "../models/invoiceModel.js"; // optional if you need invoice path

export const listLedger = async (req, res) => {
  try {
    const role = req.user.role; // 'admin' or 'agent'
    const agentId = req.user.id;
    const { startDate, endDate, status, paymentStatus, search, page = 1, limit = 25 } = req.query;

    const result = await getLedger({
      role,
      agentId,
      startDate,
      endDate,
      status,
      paymentStatus,
      search,
      page,
      limit
    });

    res.json({
      success: true,
      data: result.rows,
      meta: { total: result.total, page: result.page, limit: result.limit }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Server error" });
  }
};

// Export CSV
export const exportLedgerCsv = async (req, res) => {
  try {
    const role = req.user.role;
    const agentId = req.user.id;
    const { startDate, endDate, status, paymentStatus, search } = req.query;

    const result = await getLedger({
      role,
      agentId,
      startDate,
      endDate,
      status,
      paymentStatus,
      search,
      page: 1,
      limit: 1000000 // large so we fetch all rows for CSV (be mindful)
    });

    // Build CSV string
    const headers = [
      "Sale ID","Case ID","Agent ID","Traveller","Phone","Plan","Product Type",
      "Policy No","Certificate No","Premium","Tax","Total","Payment Status","Confirmed At"
    ];
    const lines = [headers.join(",")];

    for (const r of result.rows) {
      const row = [
        r.sale_id,
        r.case_id,
        r.agent_id,
        `"${(r.traveller_name || "").replace(/"/g, '""')}"`,
        `"${(r.traveller_phone || "").replace(/"/g,'""')}"`,
        `"${(r.plan_name || "").replace(/"/g,'""')}"`,
        r.product_type || "",
        r.policy_number || "",
        r.certificate_number || "",
        (r.premium_amount || 0).toFixed(2),
        (r.tax || 0).toFixed(2),
        (r.total || 0).toFixed(2),
        r.payment_status || "",
        r.confirmed_at ? new Date(r.confirmed_at).toISOString() : ""
      ];
      lines.push(row.join(","));
    }

    const csv = lines.join("\n");
    const fileName = `sales_ledger_${Date.now()}.csv`;

    res.header("Content-Type", "text/csv");
    res.attachment(fileName);
    return res.send(csv);
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Server error" });
  }
};
