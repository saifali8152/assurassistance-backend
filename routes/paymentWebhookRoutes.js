// src/routes/paymentWebhookRoutes.js
//
// Provider callbacks. Mounted at /api/payments/webhook in server.js, and
// mounted EARLY — before the global rate limiter, before the input sanitiser
// and before express.json() — for three reasons:
//
//   1. express.json() would consume and re-serialise the body, and the HMAC is
//      computed over the exact bytes that arrived. Key order and whitespace
//      would differ and every signature would fail.
//   2. The sanitiser rewrites request bodies, which would do the same damage.
//   3. The global limiter is keyed by IP, and every callback from one provider
//      arrives from a handful of its own addresses, so one busy minute would
//      throttle every customer at once. The controller rate-limits per provider
//      instead.
//
import express from "express";
import { receivePaymentWebhook } from "../controllers/paymentWebhookController.js";

const router = express.Router();

// `type: () => true` because providers do not agree on Content-Type: some send
// application/json, some x-www-form-urlencoded, some nothing at all. We want
// the bytes whatever they claim.
router.post(
  "/:provider",
  express.raw({ type: () => true, limit: "1mb" }),
  receivePaymentWebhook
);

export default router;
