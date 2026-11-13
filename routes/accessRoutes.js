// routes/accessRoutes.js
//
// Milestone 5 (D12). Mounted at /api/admin/access. Managing roles is for the
// main admin only — it is deliberately not a grantable permission.
// GET /me is open to any signed-in user: the panel uses it to show or hide
// the new features.
//
import express from "express";
import authenticate from "../middlewares/authMiddleware.js";
import { adminOnly } from "../middlewares/roleMiddleware.js";
import {
  getPermissionCatalogue, getMyPermissions, getRoles, postRole, putRole, putUserRole, getAudit, getStaffUsers,
} from "../controllers/accessController.js";

const router = express.Router();

router.get("/me", authenticate, getMyPermissions);
router.get("/permissions", authenticate, adminOnly, getPermissionCatalogue);
router.get("/roles", authenticate, adminOnly, getRoles);
router.post("/roles", authenticate, adminOnly, postRole);
router.put("/roles/:id", authenticate, adminOnly, putRole);
router.get("/users", authenticate, adminOnly, getStaffUsers);
router.put("/users/:id/role", authenticate, adminOnly, putUserRole);
router.get("/audit", authenticate, adminOnly, getAudit);

export default router;
