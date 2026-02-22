// src/routes/ledgerRoute.js
import express from "express";
import authenticate from "../middlewares/authMiddleware.js";
import { listLedger, exportLedgerCsv } from "../controllers/ledgerController.js";
const router = express.Router();

router.get("/", authenticate, listLedger);         // GET /api/ledger?startDate=...&page=...
router.get("/export", authenticate, exportLedgerCsv); // GET /api/ledger/export?...

export default router;
