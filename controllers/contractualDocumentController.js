import path from "path";
import fs from "fs";
import multer from "multer";
import {
  DOC_KEYS,
  isValidDocKey,
  listContractualDocuments,
  getContractualDocumentByKey,
  upsertContractualDocument,
  updateContractualDocumentMeta,
  deleteContractualDocument,
} from "../models/contractualDocumentModel.js";

const UPLOAD_DIR = path.join(process.cwd(), "uploads", "contractual-docs");
const MAX_BYTES = 15 * 1024 * 1024; // 15 MB
const ALLOWED_EXT = [".pdf", ".doc", ".docx"];

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
    cb(null, UPLOAD_DIR);
  },
  filename: (req, file, cb) => {
    const key = String(req.params.key || "doc").toLowerCase();
    const ext = path.extname(file.originalname || "").toLowerCase();
    const safeExt = ALLOWED_EXT.includes(ext) ? ext : ".pdf";
    cb(null, `${key}-${Date.now()}${safeExt}`);
  },
});

export const uploadContractualDocMiddleware = multer({
  storage,
  limits: { fileSize: MAX_BYTES },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname || "").toLowerCase();
    if (ALLOWED_EXT.includes(ext)) cb(null, true);
    else cb(new Error("Only PDF, DOC, or DOCX files are allowed"));
  },
}).single("file");

function fsPathFromPublic(rel) {
  if (!rel || typeof rel !== "string") return null;
  if (!rel.startsWith("/uploads/")) return null;
  return path.join(process.cwd(), rel.replace(/^\//, ""));
}

function unlinkQuiet(fsPath) {
  if (!fsPath) return;
  try {
    if (fs.existsSync(fsPath)) fs.unlinkSync(fsPath);
  } catch (e) {
    console.warn("Could not remove old contractual document file:", e?.message || e);
  }
}

function assertValidPdfMagic(filePath, ext) {
  if (ext !== ".pdf") return true;
  try {
    const fd = fs.openSync(filePath, "r");
    const buf = Buffer.alloc(5);
    fs.readSync(fd, buf, 0, 5, 0);
    fs.closeSync(fd);
    return buf.toString("utf8").startsWith("%PDF");
  } catch {
    return false;
  }
}

function publicDoc(doc) {
  if (!doc) return doc;
  const { file_path, ...rest } = doc;
  return {
    ...rest,
    download_url: doc.has_file ? `/api/contractual-documents/${doc.doc_key}/download` : null,
  };
}

/** GET /api/contractual-documents — any authenticated user */
export const listDocuments = async (_req, res) => {
  try {
    const docs = await listContractualDocuments();
    res.json({ success: true, data: docs.map(publicDoc), keys: DOC_KEYS });
  } catch (err) {
    console.error("Error listing contractual documents:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
};

/** GET /api/contractual-documents/:key — metadata */
export const getDocument = async (req, res) => {
  try {
    if (!isValidDocKey(req.params.key)) {
      return res.status(400).json({ success: false, message: "Invalid document key (use full or brief)" });
    }
    const doc = await getContractualDocumentByKey(req.params.key);
    if (!doc?.has_file) {
      return res.status(404).json({ success: false, message: "Document not found" });
    }
    res.json({ success: true, data: publicDoc(doc) });
  } catch (err) {
    console.error("Error getting contractual document:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
};

/** GET /api/contractual-documents/:key/download — any authenticated user */
export const downloadDocument = async (req, res) => {
  try {
    if (!isValidDocKey(req.params.key)) {
      return res.status(400).json({ success: false, message: "Invalid document key (use full or brief)" });
    }
    const doc = await getContractualDocumentByKey(req.params.key);
    if (!doc?.has_file) {
      return res.status(404).json({ success: false, message: "Document not available for download" });
    }
    const abs = fsPathFromPublic(doc.file_path);
    if (!abs || !fs.existsSync(abs)) {
      return res.status(404).json({ success: false, message: "Document file is missing on the server" });
    }
    const downloadName =
      doc.original_filename ||
      `${doc.doc_key}-terms${path.extname(abs) || ".pdf"}`;
    res.setHeader(
      "Content-Type",
      doc.mime_type || "application/octet-stream"
    );
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${String(downloadName).replace(/"/g, "")}"`
    );
    return res.sendFile(abs);
  } catch (err) {
    console.error("Error downloading contractual document:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
};

/**
 * POST /api/contractual-documents/:key
 * Admin only. multipart: file (required on first upload), title, description.
 * Replacing an existing slot may omit file to update metadata only when? — requirement
 * says upload/update/replace; require file for replace of content; allow meta-only via PATCH.
 */
export const uploadOrReplaceDocument = async (req, res) => {
  try {
    if (!isValidDocKey(req.params.key)) {
      if (req.file) unlinkQuiet(req.file.path);
      return res.status(400).json({ success: false, message: "Invalid document key (use full or brief)" });
    }

    const title = String(req.body?.title || "").trim();
    const description = String(req.body?.description || "").trim();
    if (!title) {
      if (req.file) unlinkQuiet(req.file.path);
      return res.status(400).json({ success: false, message: "Title is required" });
    }
    if (!description) {
      if (req.file) unlinkQuiet(req.file.path);
      return res.status(400).json({ success: false, message: "Short description is required" });
    }
    if (title.length > 255) {
      if (req.file) unlinkQuiet(req.file.path);
      return res.status(400).json({ success: false, message: "Title must be at most 255 characters" });
    }
    if (description.length > 1000) {
      if (req.file) unlinkQuiet(req.file.path);
      return res.status(400).json({ success: false, message: "Description must be at most 1000 characters" });
    }

    const existing = await getContractualDocumentByKey(req.params.key);
    if (!req.file && !existing?.has_file) {
      return res.status(400).json({ success: false, message: "A document file is required" });
    }

    let filePath = existing?.file_path || null;
    let originalFilename = existing?.original_filename || null;
    let mimeType = existing?.mime_type || null;
    let fileSize = existing?.file_size || null;

    if (req.file) {
      const ext = path.extname(req.file.originalname || "").toLowerCase();
      if (!assertValidPdfMagic(req.file.path, ext)) {
        unlinkQuiet(req.file.path);
        return res.status(400).json({ success: false, message: "The uploaded file is not a valid PDF" });
      }
      filePath = `/uploads/contractual-docs/${req.file.filename}`;
      originalFilename = req.file.originalname;
      mimeType = req.file.mimetype;
      fileSize = req.file.size;
    }

    const { previous, current } = await upsertContractualDocument({
      docKey: req.params.key,
      title,
      description,
      filePath,
      originalFilename,
      mimeType,
      fileSize,
      uploadedByUserId: req.user?.id,
    });

    if (req.file && previous?.file_path && previous.file_path !== filePath) {
      unlinkQuiet(fsPathFromPublic(previous.file_path));
    }

    res.json({
      success: true,
      message: previous?.has_file ? "Document replaced" : "Document uploaded",
      data: publicDoc(current),
    });
  } catch (err) {
    if (req.file) unlinkQuiet(req.file.path);
    console.error("Error uploading contractual document:", err);
    const status = err.status || 500;
    res.status(status).json({ success: false, message: err.message || "Server error" });
  }
};

/** PATCH /api/contractual-documents/:key — admin: title + description only */
export const patchDocumentMeta = async (req, res) => {
  try {
    if (!isValidDocKey(req.params.key)) {
      return res.status(400).json({ success: false, message: "Invalid document key (use full or brief)" });
    }
    const title = String(req.body?.title || "").trim();
    const description = String(req.body?.description || "").trim();
    if (!title || !description) {
      return res.status(400).json({
        success: false,
        message: "Title and short description are required",
      });
    }
    const updated = await updateContractualDocumentMeta(req.params.key, { title, description });
    if (!updated) {
      return res.status(404).json({ success: false, message: "Document not found" });
    }
    res.json({ success: true, data: publicDoc(updated) });
  } catch (err) {
    console.error("Error updating contractual document meta:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
};

/** DELETE /api/contractual-documents/:key — admin */
export const removeDocument = async (req, res) => {
  try {
    if (!isValidDocKey(req.params.key)) {
      return res.status(400).json({ success: false, message: "Invalid document key (use full or brief)" });
    }
    const removed = await deleteContractualDocument(req.params.key);
    if (!removed) {
      return res.status(404).json({ success: false, message: "Document not found" });
    }
    unlinkQuiet(fsPathFromPublic(removed.file_path));
    res.json({ success: true, message: "Document removed" });
  } catch (err) {
    console.error("Error deleting contractual document:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
};
