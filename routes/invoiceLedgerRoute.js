// src/routes/invoiceLedgerRoute.js
import express from "express";
import { authenticateAny, requireScope } from "../middlewares/apiKeyMiddleware.js";
import {
  listInvoiceLedger,
  exportInvoiceLedgerCsv
} from "../controllers/invoiceLedgerController.js";

const router = express.Router();

// Visibility is enforced in the controller (admin = all, sub_admin/agent scoped).
router.get("/", authenticateAny, requireScope("invoices:read"), listInvoiceLedger);
router.get("/export", authenticateAny, requireScope("invoices:read"), exportInvoiceLedgerCsv);

export default router;
