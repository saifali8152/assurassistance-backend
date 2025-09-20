import express from "express";
import authenticate from "../middlewares/authMiddleware.js";
import {
  createSaleController,
  getAllSalesController,
  getSaleByIdController
} from "../controllers/salesController.js";

const router = express.Router();

router.post("/", authenticate, createSaleController);
router.get("/", authenticate, getAllSalesController);
router.get("/:id", authenticate, getSaleByIdController);

export default router;
