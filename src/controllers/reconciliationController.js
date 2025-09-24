import { getMonthlyReconciliation } from "../models/salesModel.js";
import { Parser } from "json2csv";

export const getReconciliationController = async (req, res) => {
  try {
    const { month } = req.query; // e.g., "2025-09"
    if (!month) return res.status(400).json({ message: "Month is required" });

    const data = await getMonthlyReconciliation(month);
    res.json({ success: true, data });
  } catch (err) {
    console.error("Error fetching reconciliation:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
};

export const exportReconciliationCsv = async (req, res) => {
  try {
    const { month } = req.query;
    const data = await getMonthlyReconciliation(month);

    const fields = [
      "agent_name", "total_sales", "total_amount",
      "total_paid", "total_unpaid", "total_partial"
    ];
    const parser = new Parser({ fields });
    const csv = parser.parse(data);

    res.header("Content-Type", "text/csv");
    res.attachment(`reconciliation_${month}.csv`);
    return res.send(csv);
  } catch (err) {
    console.error("Error exporting CSV:", err);
    res.status(500).json({ message: "Server error" });
  }
};