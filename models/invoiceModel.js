import getPool from "../utils/db.js";

export const createInvoice = async ({ sale_id, invoice_number, subtotal, tax, total, payment_status = 'Unpaid' }) => {
  const pool = getPool();
  const [result] = await pool.execute(
    `INSERT INTO invoices (sale_id, invoice_number, subtotal, tax, total, payment_status)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [sale_id, invoice_number, subtotal, tax, total, payment_status]
  );
  return result.insertId;
};

export const updateInvoicePdf = async (invoiceId, pdfPath) => {
  const pool = getPool();
  await pool.execute(
    `UPDATE invoices SET pdf_path = ? WHERE id = ?`,
    [pdfPath, invoiceId]
  );
};

export const getInvoiceBySaleId = async (saleId) => {
  const pool = getPool();
  const [rows] = await pool.query(`SELECT * FROM invoices WHERE sale_id = ? LIMIT 1`, [saleId]);
  return rows[0];
};
