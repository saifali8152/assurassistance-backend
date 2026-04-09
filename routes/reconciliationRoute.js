import express from "express";
import authenticate from "../middlewares/authMiddleware.js";
import {
  getReconciliationController,
  exportReconciliationCsv
} from "../controllers/reconciliationController.js";

const router = express.Router();

router.get("/", authenticate, getReconciliationController);
router.get("/export", authenticate, exportReconciliationCsv);

export default router;
