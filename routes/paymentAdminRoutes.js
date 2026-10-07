// src/routes/paymentAdminRoutes.js
//
// The payments screen, mounted at /api/admin/payments.
//
// JWT and admin only, never `authenticateAny`: a third-party API key must not
// be able to read the platform's payment history, however broad its scopes.
// That is the same rule the settings routes follow, for the same reason.
//
import express from "express";
import authenticate from "../middlewares/authMiddleware.js";
import { adminOnly } from "../middlewares/roleMiddleware.js";
import {
  listPayments,
  paymentStats,
  getPayment,
  getPaymentCallbackBody,
  pollPayment,
} from "../controllers/paymentAdminController.js";

const router = express.Router();

router.use(authenticate, adminOnly);

router.get("/stats", paymentStats);
router.get("/callbacks/:callbackId/body", getPaymentCallbackBody);
router.post("/:id/poll", pollPayment);
router.get("/:id", getPayment);
router.get("/", listPayments);

export default router;
