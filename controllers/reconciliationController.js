import { getMonthlyReconciliation } from "../models/salesModel.js";
import { Parser } from "json2csv";

const MONTH_LABELS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function sqlMonthFromQuery(month, year) {
  if (!month || !year) return null;
  const idx = MONTH_LABELS.indexOf(month);
  if (idx < 0) return null;
  const monthNum = ("0" + (idx + 1)).slice(-2);
  return `${year}-${monthNum}`;
}

export const getReconciliationController = async (req, res) => {
  try {
    const { month, year } = req.query; // month: "Sep", year: "2025"
    if (!month || !year) return res.status(400).json({ message: "Month and year are required" });

    const sqlMonth = sqlMonthFromQuery(month, year);
    if (!sqlMonth) return res.status(400).json({ message: "Invalid month or year" });

    const data = await getMonthlyReconciliation(sqlMonth);
    res.json({ success: true, data });
  } catch (err) {
    console.error("Error fetching reconciliation:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
};

export const exportReconciliationCsv = async (req, res) => {
  try {
    const { month, year } = req.query;
    const sqlMonth = sqlMonthFromQuery(month, year);
    if (!sqlMonth) {
      return res.status(400).json({ message: "Month and year are required (e.g. month=Jan&year=2026)" });
    }

    const data = await getMonthlyReconciliation(sqlMonth);

    const fields = [
      "agent_name",
      "month",
      "total_sales",
      "total_amount",
      "paid_amount",
      "unpaid_amount",
      "partial_amount",
      "balance_due",
      "gross_collected",
      "fees",
      "net_due"
    ];
    const parser = new Parser({ fields });
    const csvBody = parser.parse(data || []);

    const fileName = `reconciliation_${sqlMonth}.csv`;
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
    return res.send("\uFEFF" + csvBody);
  } catch (err) {
    console.error("Error exporting CSV:", err);
    res.status(500).json({ message: "Server error" });
  }
};