// routes/partnerClaimsRoutes.js
//
// D10 — claim status for the 3rd-party API. Mounted at /api/claims.
// API key (scope claims:read) or a JWT, through the same authenticateAny the
// other partner endpoints use.
//
import express from "express";
import { authenticateAny, requireScope } from "../middlewares/apiKeyMiddleware.js";
import { getClaimStatus, listClaimStatuses } from "../controllers/partnerClaimsController.js";

const router = express.Router();
router.get("/", authenticateAny, requireScope("claims:read"), listClaimStatuses);
router.get("/:reference", authenticateAny, requireScope("claims:read"), getClaimStatus);
export default router;
