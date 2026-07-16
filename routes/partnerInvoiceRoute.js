import express from "express";
import authenticate from "../middlewares/authMiddleware.js";
import { adminOrSubAdmin } from "../middlewares/roleMiddleware.js";
import {
  listInvoicePartners,
  getPartnerInvoiceSummary,
  getPartnerInvoice,
  downloadPartnerInvoicePdf,
} from "../controllers/partnerInvoiceController.js";

const router = express.Router();

// Partner (travel agency / corporate) period invoices with commission deductions.
// Available to admins and sub-administrators (scoped to their supervised accounts).
router.get("/partners", authenticate, adminOrSubAdmin, listInvoicePartners);
router.get("/summary", authenticate, adminOrSubAdmin, getPartnerInvoiceSummary);
router.get("/:partnerId/pdf", authenticate, adminOrSubAdmin, downloadPartnerInvoicePdf);
router.get("/:partnerId", authenticate, adminOrSubAdmin, getPartnerInvoice);

export default router;
