import { getMonthlyReconciliation } from "../models/salesModel.js";
import { Parser } from "json2csv";

export const getReconciliationController = async (req, res) => {
  try {
    const { month, year } = req.query; // month: "Sep", year: "2025"
    if (!month || !year) return res.status(400).json({ message: "Month and year are required" });

    // Convert to "YYYY-MM" for SQL
    const monthNum = ("0" + (["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"].indexOf(month) + 1)).slice(-2);
    const sqlMonth = `${year}-${monthNum}`;

    const data = await getMonthlyReconciliation(sqlMonth);
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