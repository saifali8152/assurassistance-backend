//src/models/salesModel.js
import getPool from "../utils/db.js";

// Create Sale
export const createSale = async (data) => {
  const pool = getPool();
  const { 
    case_id, 
    policy_number, 
    certificate_number, 
    premium_amount, 
    tax, 
    total,
    currency = 'XOF',
    plan_price = 0,
    guarantees_total = 0,
    guarantees_details = null
  } = data;
  
  // Convert guarantees_details to JSON string if it's an array/object, otherwise null
  const guaranteesDetailsJson = (guarantees_details !== null && guarantees_details !== undefined) 
    ? JSON.stringify(guarantees_details) 
    : null;
  
  const [result] = await pool.execute(
    `INSERT INTO sales (case_id, policy_number, certificate_number, premium_amount, tax, total, currency, plan_price, guarantees_total, guarantees_details, payment_status, confirmed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Unpaid', NOW())`,
    [case_id, policy_number, certificate_number, premium_amount, tax, total, currency, plan_price, guarantees_total, guaranteesDetailsJson]
  );
  return result.insertId;
};

// Get all sales
export const getAllSales = async () => {
  const pool = getPool();
  const [rows] = await pool.query(`SELECT * FROM sales ORDER BY confirmed_at DESC`);
  return rows;
};

// Get sale by ID
export const getSaleById = async (id) => {
  const pool = getPool();
  const [rows] = await pool.query(`SELECT * FROM sales WHERE id = ?`, [id]);
  return rows[0];
};

// Update payment status + notes
export const updatePaymentStatus = async (saleId, payment_status, payment_notes) => {
  const pool = getPool();
  const [result] = await pool.execute(
    `UPDATE sales 
     SET payment_status = ?, payment_notes = ? 
     WHERE id = ?`,
    [payment_status, payment_notes || null, saleId]
  );
  return result.affectedRows;
};

export const getMonthlyReconciliation = async (month) => {
  const pool = getPool();
  // month format: "2025-09"
  const [rows] = await pool.query(
    `SELECT 
        u.id as user_id,
        u.name as agent_name,
        DATE_FORMAT(s.confirmed_at, '%b-%Y') as month,
        COUNT(s.id) as total_sales,
        SUM(s.total) as total_amount,
        SUM(CASE WHEN s.payment_status='Paid' THEN s.total ELSE 0 END) as paid_amount,
        SUM(CASE WHEN s.payment_status='Unpaid' THEN s.total ELSE 0 END) as unpaid_amount,
        SUM(CASE WHEN s.payment_status='Partial' THEN s.total ELSE 0 END) as partial_amount,
        SUM(s.total) - SUM(s.received_amount) as balance_due,
        SUM(s.received_amount) as gross_collected,
        SUM(s.tax) as fees,
        SUM(s.received_amount) - SUM(s.tax) as net_due
     FROM sales s
     JOIN cases c ON c.id = s.case_id
     JOIN users u ON u.id = c.created_by
     WHERE DATE_FORMAT(s.confirmed_at, '%Y-%m') = ?
     GROUP BY u.id, month`,
    [month]
  );
  return rows;
};
