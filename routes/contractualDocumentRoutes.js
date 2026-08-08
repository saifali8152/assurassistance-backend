import express from "express";
import authenticate from "../middlewares/authMiddleware.js";
import { adminOnly } from "../middlewares/roleMiddleware.js";
import {
  listDocuments,
  getDocument,
  downloadDocument,
  uploadOrReplaceDocument,
  patchDocumentMeta,
  removeDocument,
  uploadContractualDocMiddleware,
} from "../controllers/contractualDocumentController.js";

const router = express.Router();

// All logged-in users may list and download.
router.get("/", authenticate, listDocuments);
router.get("/:key/download", authenticate, downloadDocument);
router.get("/:key", authenticate, getDocument);

// Admin only: upload / replace / update metadata / delete.
router.post(
  "/:key",
  authenticate,
  adminOnly,
  (req, res, next) => {
    uploadContractualDocMiddleware(req, res, (err) => {
      if (err) {
        return res.status(400).json({ success: false, message: err.message || "Upload failed" });
      }
      next();
    });
  },
  uploadOrReplaceDocument
);
router.patch("/:key", authenticate, adminOnly, patchDocumentMeta);
router.delete("/:key", authenticate, adminOnly, removeDocument);

export default router;
