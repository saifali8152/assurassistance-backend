//src/routes/salesRoute.js
import express from "express";
import authenticate from "../middlewares/authMiddleware.js";
import {
  createSaleController,
  getAllSalesController,
  getSaleByIdController,
  updatePaymentStatusController
} from "../controllers/salesController.js";
import { downloadInvoice, downloadCertificate } from "../controllers/documentController.js";

const router = express.Router();

router.post("/", authenticate, createSaleController);
router.get("/", authenticate, getAllSalesController);

// download links (must come before /:id route)
router.get("/invoice/:id", authenticate, downloadInvoice);
router.get("/certificate/:id", authenticate, downloadCertificate);

router.get("/:id", authenticate, getSaleByIdController);
router.patch("/:id/payment", authenticate, updatePaymentStatusController);
export default router;
