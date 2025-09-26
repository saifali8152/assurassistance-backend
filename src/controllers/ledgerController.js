// src/controllers/ledgerController.js
import { getLedger } from "../models/ledgerModel.js";
import { getInvoiceBySaleId } from "../models/invoiceModel.js"; // optional if you need invoice path
import { format } from "@fast-csv/format";
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
      limit: 1000000
    });

    const fileName = `sales_ledger_${Date.now()}.csv`;
    res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.write("\uFEFF"); // BOM for Excel

    const csvStream = format({ headers: true, quoteColumns: true });
    csvStream.pipe(res);

    result.rows.forEach(r => {
      csvStream.write({
        "Sale ID": r.sale_id,
        "Traveller": r.traveller_name || "",
        "Plan": r.plan_name || "",
        "Total": r.total || 0,
        "Received Amount": r.received_amount || 0,
        "Payment": r.policy_number || "",   // or certificate_number if needed
        "Confirmed At": r.confirmed_at ? new Date(r.confirmed_at).toLocaleString() : "",
        "Payment Status": r.payment_status || "",
        "Notes": r.payment_notes || ""
      });
    });

    csvStream.end();
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Server error" });
  }
};