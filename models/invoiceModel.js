import getPool from "../utils/db.js";

const MAX_AMOUNT = 999999999999.99;
const toAmount = (v) => {
  if (v == null || v === '') return 0;
  const n = Number(v);
  if (Number.isNaN(n) || !Number.isFinite(n)) return 0;
  const rounded = Math.round(n * 100) / 100;
  return Math.max(-MAX_AMOUNT, Math.min(MAX_AMOUNT, rounded));
};

export const createInvoice = async ({ sale_id, invoice_number, subtotal, tax, total, payment_status = 'Unpaid' }) => {
  const pool = getPool();
  const subtotalVal = toAmount(subtotal);
  const taxVal = toAmount(tax);
  const totalVal = toAmount(total);
  const [result] = await pool.execute(
    `INSERT INTO invoices (sale_id, invoice_number, subtotal, tax, total, payment_status)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [sale_id, invoice_number, subtotalVal, taxVal, totalVal, payment_status]
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
