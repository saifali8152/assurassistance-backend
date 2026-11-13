// routes/externalPolicyRoutes.js
//
// Milestone 5, Day 10. Mounted at /api/admin/external-policies.
// JWT + the policies.import permission (D12/D13).
//
import express from "express";
import authenticate from "../middlewares/authMiddleware.js";
import { requirePermission } from "../middlewares/permissionMiddleware.js";
import * as c from "../controllers/externalPolicyController.js";

const router = express.Router();
router.use(authenticate, requirePermission("policies.import"));

router.get("/columns", c.getColumns);
router.get("/template", c.getTemplate);
router.get("/", c.getList);
router.post("/", c.postOne);
router.post("/import/preview", c.postPreview);
router.post("/import", c.postCommit);
router.put("/:id/status", c.putStatus);

export default router;
