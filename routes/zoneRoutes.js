// src/routes/zoneRoutes.js
//
// Destination zone map. Readable with a scope; writable only by the superadmin
// with a JWT — a partner must never be able to move a country into a cheaper zone.
//
import express from "express";
import { authenticateAny, requireScope } from "../middlewares/apiKeyMiddleware.js";
import authenticate from "../middlewares/authMiddleware.js";
import { adminOnly } from "../middlewares/roleMiddleware.js";
import {
  listZonesController,
  listZoneCountriesController,
  resolveZoneController,
  assignZoneController,
} from "../controllers/zoneController.js";

const router = express.Router();

router.get("/countries", authenticateAny, requireScope("zones:read"), listZoneCountriesController);
router.get("/resolve", authenticateAny, requireScope("zones:read"), resolveZoneController);
router.get("/", authenticateAny, requireScope("zones:read"), listZonesController);

router.patch("/assign", authenticate, adminOnly, assignZoneController);

export default router;
