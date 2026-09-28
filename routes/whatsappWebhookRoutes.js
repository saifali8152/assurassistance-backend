// src/routes/whatsappWebhookRoutes.js
//
// Meta's webhook. Mounted SEPARATELY and EARLY in server.js, for three reasons:
//
//   1. express.raw() must see the body before express.json() consumes it —
//      X-Hub-Signature-256 is computed over the exact bytes Meta sent, and a
//      parsed-then-reserialised body will never produce a matching signature.
//   2. The app's input-sanitisation middleware rewrites req.body; that would also
//      invalidate the signature.
//   3. Mounting before the global per-IP rate limiter keeps Meta's traffic — which
//      all arrives from a handful of Meta IPs — from being throttled as if it were
//      one abusive client. Flood protection is applied per phone number instead,
//      inside the controller.
//
// No authentication middleware here on purpose: the signature IS the
// authentication, and an Authorization header is something Meta will never send.
//
import express from "express";
import { verifyWebhook, receiveWebhook } from "../controllers/whatsappController.js";

const router = express.Router();

// Meta's one-time verification handshake.
router.get("/", verifyWebhook);

// Inbound messages and delivery receipts.
router.post(
  "/",
  express.raw({ type: () => true, limit: "1mb" }),
  receiveWebhook
);

export default router;
