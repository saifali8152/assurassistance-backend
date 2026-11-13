// src/routes/whatsappRoutes.js
//
// Read/write APIs over the WhatsApp module, for our own admin screens AND for
// 3rd-party integrations, through the same `authenticateAny` + `requireScope`
// pattern the rest of the public API uses.
//
// The webhook itself is NOT here — see routes/whatsappWebhookRoutes.js.
//
import express from "express";
import { authenticateAny, requireScope } from "../middlewares/apiKeyMiddleware.js";
import authenticate from "../middlewares/authMiddleware.js";
import { adminOnly } from "../middlewares/roleMiddleware.js";
import {
  getSessions,
  getSession,
  getSessionMessages,
  sendMessage,
  getPublicStatus,
  getStats,
  pruneMessages,
} from "../controllers/whatsappController.js";

const router = express.Router();

/**
 * Transcripts and outbound messages: an API key is governed by its scopes
 * (checked next, by requireScope); a signed-in user must be the main admin —
 * the only role with the WhatsApp Conversations screen. Before this, any
 * signed-in user (an agent included) could read every transcript and send a
 * WhatsApp message to any number.
 */
const adminUnlessApiKey = (req, res, next) =>
  req.authMode === "api_key" ? next() : adminOnly(req, res, next);

// Non-secret runtime status (enabled, business number, languages): any
// authenticated caller with read access.
router.get("/status", authenticateAny, requireScope("whatsapp:read"), getPublicStatus);

// Conversation transcripts contain personal data, so reading them needs an
// explicit scope rather than riding along with cases:read.
router.get("/sessions", authenticateAny, adminUnlessApiKey, requireScope("whatsapp:read"), getSessions);
router.get("/sessions/:id", authenticateAny, adminUnlessApiKey, requireScope("whatsapp:read"), getSession);
router.get("/sessions/:id/messages", authenticateAny, adminUnlessApiKey, requireScope("whatsapp:read"), getSessionMessages);

// Message-count instrumentation against the message budget (8–11).
router.get("/stats", authenticateAny, adminUnlessApiKey, requireScope("whatsapp:read"), getStats);

router.post("/messages", authenticateAny, adminUnlessApiKey, requireScope("whatsapp:write"), sendMessage);

// Deleting transcripts is superadmin-only and never available to an API key.
router.post("/maintenance/prune", authenticate, adminOnly, pruneMessages);

export default router;
