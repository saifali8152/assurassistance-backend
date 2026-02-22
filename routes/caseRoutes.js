//src/routes/caseRoute.js
import express from "express";
import authenticate from "../middlewares/authMiddleware.js";
import { 
  createCaseWithTraveller, 
  getMyCases, 
  getPendingSales, 
  changeCaseStatus,
  getAllCases,
  getMyCasesWithPagination,
  confirmSale,
  cancelCase,
  updateCase
} from "../controllers/caseController.js";

const router = express.Router();

router.post("/", authenticate, createCaseWithTraveller);
router.get("/", authenticate, getMyCases);
router.get("/all", authenticate, getAllCases); // Admin only - all cases with pagination
router.get("/my-cases", authenticate, getMyCasesWithPagination); // Agent cases with pagination
router.get("/pending-sales", authenticate, getPendingSales);
router.patch("/:id/status", authenticate, changeCaseStatus);
router.post("/:caseId/confirm-sale", authenticate, confirmSale); // Admin only
router.post("/:caseId/cancel", authenticate, cancelCase); // Admin only
router.put("/:caseId/update", authenticate, updateCase); // Update case

export default router;
