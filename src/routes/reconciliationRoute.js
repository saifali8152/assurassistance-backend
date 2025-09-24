import express from "express";
import authenticate from "../middlewares/authMiddleware.js";
import { getReconciliationController } from "../controllers/reconciliationController.js";

const router = express.Router();

router.get("/", authenticate, getReconciliationController);

export default router;
