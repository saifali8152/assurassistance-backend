//src/routes/caseRoute.js
import express from "express";
import { authenticateAny, requireScope } from "../middlewares/apiKeyMiddleware.js";
import authenticate from "../middlewares/authMiddleware.js";
import { adminOnly } from "../middlewares/roleMiddleware.js";
import {
  createCaseWithTraveller,
  createGroupCasesWithTravellers,
  getMyCases,
  getPendingSales,
  changeCaseStatus,
  getAllCases,
  getMyCasesWithPagination,
  confirmSale,
  cancelCase,
  deleteCase,
  updateCase,
  getPolicyEditMeta,
  getCaseById
} from "../controllers/caseController.js";

const router = express.Router();

router.post("/group", authenticateAny, requireScope("cases:write"), createGroupCasesWithTravellers);
router.post("/", authenticateAny, requireScope("cases:write"), createCaseWithTraveller);
router.get("/", authenticateAny, requireScope("cases:read"), getMyCases);
router.get("/all", authenticateAny, requireScope("cases:read"), getAllCases);
router.get("/my-cases", authenticateAny, requireScope("cases:read"), getMyCasesWithPagination);
router.get("/pending-sales", authenticateAny, requireScope("cases:read"), getPendingSales);
router.patch("/:id/status", authenticateAny, requireScope("cases:write"), changeCaseStatus);
router.post("/:caseId/confirm-sale", authenticateAny, requireScope("sales:write"), confirmSale);
router.post("/:caseId/cancel", authenticateAny, requireScope("cases:write"), cancelCase);
// Hard delete — superadmin (admin role) only; JWT required (not API keys).
router.delete("/:caseId", authenticate, adminOnly, deleteCase);
router.put("/:caseId/update", authenticateAny, requireScope("cases:write"), updateCase);
router.get("/:caseId/policy-edit-meta", authenticateAny, requireScope("cases:read"), getPolicyEditMeta);
router.get("/:caseId", authenticateAny, requireScope("cases:read"), getCaseById);

export default router;
