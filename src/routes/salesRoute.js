//src/routes/salesRoute.js
import express from "express";
import authenticate from "../middlewares/authMiddleware.js";
import {
  createSaleController,
  getAllSalesController,
  getSaleByIdController
} from "../controllers/salesController.js";
import { downloadInvoice, downloadCertificate } from "../controllers/documentController.js";

const router = express.Router();

router.post("/", authenticate, createSaleController);
router.get("/", authenticate, getAllSalesController);
router.get("/:id", authenticate, getSaleByIdController);

// download links
router.get("/:id/invoice", authenticate, downloadInvoice);
router.get("/:id/certificate", authenticate, downloadCertificate);

export default router;
