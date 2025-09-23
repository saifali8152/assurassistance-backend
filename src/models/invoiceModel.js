import pool from "../db.js";

export const createInvoice = async ({ sale_id, invoice_number, subtotal, tax, total, payment_status = 'Unpaid' }) => {
  const [result] = await pool.execute(
    `INSERT INTO invoices (sale_id, invoice_number, subtotal, tax, total, payment_status)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [sale_id, invoice_number, subtotal, tax, total, payment_status]
  );
  return result.insertId;
};

export const updateInvoicePdf = async (invoiceId, pdfPath) => {
  await pool.execute(
    `UPDATE invoices SET pdf_path = ? WHERE id = ?`,
    [pdfPath, invoiceId]
  );
};

export const getInvoiceBySaleId = async (saleId) => {
  const [rows] = await pool.query(`SELECT * FROM invoices WHERE sale_id = ? LIMIT 1`, [saleId]);
  return rows[0];
};
