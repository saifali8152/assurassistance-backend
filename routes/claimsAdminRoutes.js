// routes/claimsAdminRoutes.js
//
// Milestone 5, Days 11–12. Mounted at /api/admin/claims.
// JWT only (never an API key) and one permission per action (D12).
//
import express from "express";
import authenticate from "../middlewares/authMiddleware.js";
import { requirePermission } from "../middlewares/permissionMiddleware.js";
import * as c from "../controllers/claimsAdminController.js";

const router = express.Router();

// The signed file link carries its own authorisation (see the controller).
router.get("/documents/:docId/file", c.getDocumentFile);

router.use(authenticate);

router.get("/summary", requirePermission("claims.view", "claims.activate"), c.getSummary);

router.get("/settings", requirePermission("claims.settings"), c.getClaimSettings);
router.put("/settings", requirePermission("claims.settings"), c.putClaimSettings);

router.get("/categories", requirePermission("claims.categories", "claims.view"), c.getCategories);
router.post("/categories", requirePermission("claims.categories"), c.postCategory);
router.put("/categories/:code", requirePermission("claims.categories"), c.putCategory);

router.get("/activation", requirePermission("claims.activate", "claims.allowlist"), c.getActivation);
router.put("/activation", requirePermission("claims.activate"), c.putActivation);
router.get("/allowlist", requirePermission("claims.allowlist", "claims.activate"), c.getAllowlist);
router.post("/allowlist", requirePermission("claims.allowlist"), c.postAllowlist);
router.delete("/allowlist/:waNumber", requirePermission("claims.allowlist"), c.deleteAllowlist);

router.get("/", requirePermission("claims.view"), c.getClaims);
router.get("/:id", requirePermission("claims.view"), c.getClaim);
router.post("/:id/status", requirePermission("claims.update_status"), c.postStatus);
router.get("/:id/documents/:docId/link", requirePermission("claims.documents"), c.getDocumentLink);

export default router;
