//src/models/salesModel.js
import pool from "../db.js";

// Create Sale
export const createSale = async (data) => {
  const { case_id, policy_number, certificate_number, premium_amount, tax, total } = data;
  const [result] = await pool.execute(
    `INSERT INTO sales (case_id, policy_number, certificate_number, premium_amount, tax, total, payment_status, confirmed_at)
     VALUES (?, ?, ?, ?, ?, ?, 'Unpaid', NOW())`,
    [case_id, policy_number, certificate_number, premium_amount, tax, total]
  );
  return result.insertId;
};

// Get all sales
export const getAllSales = async () => {
  const [rows] = await pool.query(`SELECT * FROM sales ORDER BY confirmed_at DESC`);
  return rows;
};

// Get sale by ID
export const getSaleById = async (id) => {
  const [rows] = await pool.query(`SELECT * FROM sales WHERE id = ?`, [id]);
  return rows[0];
};

// Update payment status + notes
export const updatePaymentStatus = async (saleId, payment_status, payment_notes) => {
  const [result] = await pool.execute(
    `UPDATE sales 
     SET payment_status = ?, payment_notes = ? 
     WHERE id = ?`,
    [payment_status, payment_notes || null, saleId]
  );
  return result.affectedRows;
};

export const getMonthlyReconciliation = async (month) => {
  const [rows] = await pool.query(
    `SELECT 
        u.id as user_id,
        u.full_name as agent_name,
        COUNT(s.id) as total_sales,
        SUM(s.total) as total_amount,
        SUM(CASE WHEN s.payment_status='Paid' THEN s.total ELSE 0 END) as total_paid,
        SUM(CASE WHEN s.payment_status='Unpaid' THEN s.total ELSE 0 END) as total_unpaid,
        SUM(CASE WHEN s.payment_status='Partial' THEN s.total ELSE 0 END) as total_partial
     FROM sales s
     JOIN users u ON u.id = s.created_by
     WHERE DATE_FORMAT(s.created_at, '%Y-%m') = ?
     GROUP BY u.id`,
    [month]
  );
  return rows;
};


