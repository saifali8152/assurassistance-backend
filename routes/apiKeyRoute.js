// src/routes/apiKeyRoute.js
//
// Admin-only management of 3rd-party API keys. Mounted at /api/admin/api-keys
// inside server.js so the existing /api/admin tree continues to own auth-y
// resources.
//
import express from "express";
import authenticate from "../middlewares/authMiddleware.js";
import { adminOnly } from "../middlewares/roleMiddleware.js";
import {
  listScopes,
  createApiKey,
  listApiKeysController,
  getApiKeyController,
  updateApiKeyController,
  revokeApiKeyController,
  rotateApiKeyController
} from "../controllers/apiKeyController.js";

const router = express.Router();

router.get("/scopes", authenticate, adminOnly, listScopes);
router.post("/", authenticate, adminOnly, createApiKey);
router.get("/", authenticate, adminOnly, listApiKeysController);
router.get("/:id", authenticate, adminOnly, getApiKeyController);
router.patch("/:id", authenticate, adminOnly, updateApiKeyController);
router.post("/:id/rotate", authenticate, adminOnly, rotateApiKeyController);
router.delete("/:id", authenticate, adminOnly, revokeApiKeyController);

export default router;
