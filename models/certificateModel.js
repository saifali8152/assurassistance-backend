import getPool from "../utils/db.js";

export const createCertificate = async ({ sale_id, certificate_number, coverage_summary }) => {
  const pool = getPool();
  const [result] = await pool.execute(
    `INSERT INTO certificates (sale_id, certificate_number, coverage_summary)
     VALUES (?, ?, ?)`,
    [sale_id, certificate_number, coverage_summary]
  );
  return result.insertId;
};

export const updateCertificatePdf = async (certId, pdfPath) => {
  const pool = getPool();
  await pool.execute(
    `UPDATE certificates SET pdf_path = ? WHERE id = ?`,
    [pdfPath, certId]
  );
};

export const getCertificateBySaleId = async (saleId) => {
  const pool = getPool();
  const [rows] = await pool.query(`SELECT * FROM certificates WHERE sale_id = ? LIMIT 1`, [saleId]);
  return rows[0];
};
