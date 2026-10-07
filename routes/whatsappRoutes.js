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

// Non-secret runtime status: any authenticated caller with read access.
router.get("/status", authenticateAny, requireScope("whatsapp:read"), getPublicStatus);

// Conversation transcripts contain personal data, so reading them needs an
// explicit scope rather than riding along with cases:read.
router.get("/sessions", authenticateAny, requireScope("whatsapp:read"), getSessions);
router.get("/sessions/:id", authenticateAny, requireScope("whatsapp:read"), getSession);
router.get("/sessions/:id/messages", authenticateAny, requireScope("whatsapp:read"), getSessionMessages);

// Message-count instrumentation against the message budget (8–11).
router.get("/stats", authenticateAny, requireScope("whatsapp:read"), getStats);

router.post("/messages", authenticateAny, requireScope("whatsapp:write"), sendMessage);

// Deleting transcripts is superadmin-only and never available to an API key.
router.post("/maintenance/prune", authenticate, adminOnly, pruneMessages);

export default router;
