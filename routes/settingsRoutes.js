// src/routes/settingsRoutes.js
//
// Superadmin-only settings endpoints. Mounted at /api/admin/whatsapp-settings.
//
// Deliberately JWT-only (`authenticate`, not `authenticateAny`): a 3rd-party API
// key must never be able to read or rewrite our Meta credentials, however broad
// its scopes are. `adminOnly` restricts this to the `admin` role — sub-admins and
// insurer supervisors manage business, not platform credentials.
//
import express from "express";
import authenticate from "../middlewares/authMiddleware.js";
import { adminOnly } from "../middlewares/roleMiddleware.js";
import {
  getWhatsAppSettings,
  updateWhatsAppSettings,
  testWhatsAppConnection,
  regenerateVerifyToken,
  revealVerifyToken,
  listAttributionCandidates,
  getPlatformSettings,
  updatePlatformSettings,
} from "../controllers/settingsController.js";

const router = express.Router();

router.use(authenticate, adminOnly);

router.get("/attribution-candidates", listAttributionCandidates);
router.get("/verify-token", revealVerifyToken);
router.post("/verify-token", regenerateVerifyToken);
router.post("/test", testWhatsAppConnection);
// Numbering, company identity, certificate wording and payment providers.
// Same router, same JWT-and-admin-only rule: an API key must never read the
// insurer's provider credentials, whatever its scopes.
router.get("/platform", getPlatformSettings);
router.put("/platform", updatePlatformSettings);

router.get("/", getWhatsAppSettings);
router.put("/", updateWhatsAppSettings);

export default router;
