import { randomBytes } from "crypto";
import getPool from "../utils/db.js";

export function generatePublicToken() {
  return randomBytes(24).toString("hex");
}

export const createCertificate = async ({ sale_id, certificate_number, coverage_summary, public_token }) => {
  const pool = getPool();
  const [result] = await pool.execute(
    `INSERT INTO certificates (sale_id, certificate_number, public_token, coverage_summary)
     VALUES (?, ?, ?, ?)`,
    [sale_id, certificate_number, public_token || null, coverage_summary]
  );
  return result.insertId;
};

/** Ensure a row has public_token (for legacy rows created before this column existed). */
export const ensureCertificatePublicToken = async (certId) => {
  const pool = getPool();
  for (let attempt = 0; attempt < 8; attempt++) {
    const [rows] = await pool.query(`SELECT id, public_token FROM certificates WHERE id = ? LIMIT 1`, [certId]);
    const row = rows[0];
    if (!row) return null;
    if (row.public_token) return row.public_token;
    const token = generatePublicToken();
    try {
      await pool.execute(`UPDATE certificates SET public_token = ? WHERE id = ? AND public_token IS NULL`, [
        token,
        certId
      ]);
      const [again] = await pool.query(`SELECT public_token FROM certificates WHERE id = ?`, [certId]);
      if (again[0]?.public_token) return again[0].public_token;
    } catch (e) {
      if (e?.code === "ER_DUP_ENTRY") continue;
      throw e;
    }
  }
  throw new Error("Could not assign public_token");
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

export const getCertificateByPublicToken = async (token) => {
  if (!token || String(token).trim() === "") return null;
  const pool = getPool();
  const [rows] = await pool.query(`SELECT * FROM certificates WHERE public_token = ? LIMIT 1`, [
    String(token).trim()
  ]);
  return rows[0];
};
