import express from "express";
import authenticate from "../middlewares/authMiddleware.js";
import { createCaseWithTraveller, getMyCases, changeCaseStatus } from "../controllers/caseController.js";

const router = express.Router();

router.post("/", authenticate, createCaseWithTraveller);
router.get("/", authenticate, getMyCases);
router.patch("/:id/status", authenticate, changeCaseStatus);

export default router;
