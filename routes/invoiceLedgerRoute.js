// src/routes/invoiceLedgerRoute.js
import express from "express";
import authenticate from "../middlewares/authMiddleware.js";
import {
  listInvoiceLedger,
  exportInvoiceLedgerCsv
} from "../controllers/invoiceLedgerController.js";

const router = express.Router();

// Visibility is enforced in the controller (admin = all, sub_admin/agent scoped).
router.get("/", authenticate, listInvoiceLedger);
router.get("/export", authenticate, exportInvoiceLedgerCsv);

export default router;
