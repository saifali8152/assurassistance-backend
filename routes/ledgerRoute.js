// src/routes/ledgerRoute.js
import express from "express";
import { authenticateAny, requireScope } from "../middlewares/apiKeyMiddleware.js";
import { listLedger, exportLedgerCsv } from "../controllers/ledgerController.js";
const router = express.Router();

router.get("/", authenticateAny, requireScope("ledger:read"), listLedger);
router.get("/export", authenticateAny, requireScope("ledger:read"), exportLedgerCsv);

export default router;
