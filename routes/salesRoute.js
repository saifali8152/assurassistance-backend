//src/routes/salesRoute.js
import express from "express";
import { authenticateAny, requireScope } from "../middlewares/apiKeyMiddleware.js";
import {
  createSaleController,
  getAllSalesController,
  getSaleByIdController,
  updatePaymentStatusController
} from "../controllers/salesController.js";
import {
  downloadInvoice,
  downloadCertificate,
  downloadGroupCertificatesZip,
  downloadGroupInvoicesZip,
  getCertificatePageData,
  getCertificatePageDataPublic
} from "../controllers/documentController.js";

const router = express.Router();

router.post("/", authenticateAny, requireScope("sales:write"), createSaleController);
router.get("/", authenticateAny, requireScope("sales:read"), getAllSalesController);

// download links (must come before /:id route)
router.get("/group/:groupId/certificates-zip", authenticateAny, requireScope("sales:read"), downloadGroupCertificatesZip);
router.get("/group/:groupId/invoices-zip", authenticateAny, requireScope("sales:read"), downloadGroupInvoicesZip);
router.get("/invoice/:id", authenticateAny, requireScope("sales:read"), downloadInvoice);
/** Public certificate JSON (QR link) — intentionally no auth (public token). */
router.get("/certificate/public/:token", getCertificatePageDataPublic);
router.get("/certificate/:id/page", authenticateAny, requireScope("sales:read"), getCertificatePageData);
router.get("/certificate/:id", authenticateAny, requireScope("sales:read"), downloadCertificate);

router.get("/:id", authenticateAny, requireScope("sales:read"), getSaleByIdController);
router.patch("/:id/payment", authenticateAny, requireScope("sales:payment"), updatePaymentStatusController);
export default router;
