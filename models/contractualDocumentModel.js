import getPool from "../utils/db.js";

export const DOC_KEYS = ["full", "brief"];

export function isValidDocKey(key) {
  return DOC_KEYS.includes(String(key || "").toLowerCase());
}

function mapRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    doc_key: row.doc_key,
    title: row.title,
    description: row.description,
    file_path: row.file_path,
    original_filename: row.original_filename,
    mime_type: row.mime_type,
    file_size: row.file_size != null ? Number(row.file_size) : null,
    uploaded_by_user_id: row.uploaded_by_user_id,
    created_at: row.created_at,
    updated_at: row.updated_at,
    has_file: Boolean(row.file_path),
  };
}

/** Always returns both slots (full, brief), with null fields when not uploaded yet. */
export async function listContractualDocuments() {
  const pool = getPool();
  const [rows] = await pool.query(
    `SELECT id, doc_key, title, description, file_path, original_filename,
            mime_type, file_size, uploaded_by_user_id, created_at, updated_at
     FROM contractual_documents
     ORDER BY FIELD(doc_key, 'full', 'brief')`
  );
  const byKey = new Map(rows.map((r) => [r.doc_key, mapRow(r)]));
  return DOC_KEYS.map((key) => {
    if (byKey.has(key)) return byKey.get(key);
    return {
      id: null,
      doc_key: key,
      title: null,
      description: null,
      file_path: null,
      original_filename: null,
      mime_type: null,
      file_size: null,
      uploaded_by_user_id: null,
      created_at: null,
      updated_at: null,
      has_file: false,
    };
  });
}

export async function getContractualDocumentByKey(docKey) {
  if (!isValidDocKey(docKey)) return null;
  const pool = getPool();
  const [rows] = await pool.query(
    `SELECT id, doc_key, title, description, file_path, original_filename,
            mime_type, file_size, uploaded_by_user_id, created_at, updated_at
     FROM contractual_documents
     WHERE doc_key = ?
     LIMIT 1`,
    [String(docKey).toLowerCase()]
  );
  return mapRow(rows[0] || null);
}

/**
 * Insert or replace a document slot.
 * @returns {{ previous: object|null, current: object }}
 */
export async function upsertContractualDocument({
  docKey,
  title,
  description,
  filePath,
  originalFilename,
  mimeType,
  fileSize,
  uploadedByUserId,
}) {
  const key = String(docKey).toLowerCase();
  if (!isValidDocKey(key)) {
    throw Object.assign(new Error("Invalid document key"), { status: 400 });
  }
  const previous = await getContractualDocumentByKey(key);
  const pool = getPool();
  await pool.query(
    `INSERT INTO contractual_documents
       (doc_key, title, description, file_path, original_filename, mime_type, file_size, uploaded_by_user_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       title = VALUES(title),
       description = VALUES(description),
       file_path = VALUES(file_path),
       original_filename = VALUES(original_filename),
       mime_type = VALUES(mime_type),
       file_size = VALUES(file_size),
       uploaded_by_user_id = VALUES(uploaded_by_user_id)`,
    [
      key,
      title,
      description,
      filePath,
      originalFilename || null,
      mimeType || null,
      fileSize != null ? Number(fileSize) : null,
      uploadedByUserId || null,
    ]
  );
  const current = await getContractualDocumentByKey(key);
  return { previous, current };
}

export async function updateContractualDocumentMeta(docKey, { title, description }) {
  const key = String(docKey).toLowerCase();
  if (!isValidDocKey(key)) return null;
  const existing = await getContractualDocumentByKey(key);
  if (!existing?.has_file) return null;
  const pool = getPool();
  await pool.query(
    `UPDATE contractual_documents
     SET title = ?, description = ?
     WHERE doc_key = ?`,
    [title, description, key]
  );
  return getContractualDocumentByKey(key);
}

export async function deleteContractualDocument(docKey) {
  const key = String(docKey).toLowerCase();
  if (!isValidDocKey(key)) return null;
  const existing = await getContractualDocumentByKey(key);
  if (!existing) return null;
  const pool = getPool();
  await pool.query(`DELETE FROM contractual_documents WHERE doc_key = ?`, [key]);
  return existing;
}
