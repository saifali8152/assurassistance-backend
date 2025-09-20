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
