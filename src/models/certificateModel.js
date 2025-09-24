import pool from "../db.js";

export const createCertificate = async ({ sale_id, certificate_number, coverage_summary }) => {
  const [result] = await pool.execute(
    `INSERT INTO certificates (sale_id, certificate_number, coverage_summary)
     VALUES (?, ?, ?)`,
    [sale_id, certificate_number, coverage_summary]
  );
  return result.insertId;
};

export const updateCertificatePdf = async (certId, pdfPath) => {
  await pool.execute(
    `UPDATE certificates SET pdf_path = ? WHERE id = ?`,
    [pdfPath, certId]
  );
};

export const getCertificateBySaleId = async (saleId) => {
  const [rows] = await pool.query(`SELECT * FROM certificates WHERE sale_id = ? LIMIT 1`, [saleId]);
  return rows[0];
};
