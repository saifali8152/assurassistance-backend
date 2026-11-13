// routes/simulatorRoutes.js
//
// Milestone 5, Day 12 — the WhatsApp simulator (D11). Mounted at
// /api/admin/simulator. JWT + simulator.use.
//
import express from "express";
import authenticate from "../middlewares/authMiddleware.js";
import { requirePermission } from "../middlewares/permissionMiddleware.js";
import { getInfo, postReset, postMessage } from "../controllers/simulatorController.js";

const router = express.Router();
router.use(authenticate, requirePermission("simulator.use"));
router.get("/", getInfo);
router.post("/reset", postReset);
router.post("/message", postMessage);
export default router;
