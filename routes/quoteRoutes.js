// src/routes/quoteRoutes.js
//
// The quoting API. Available to our own frontend (JWT) and to 3rd-party keys
// through the same authenticateAny + requireScope pattern as cases and sales.
//
import express from "express";
import { authenticateAny, requireScope } from "../middlewares/apiKeyMiddleware.js";
import {
  priceQuote,
  createQuoteController,
  listQuotesController,
  getQuoteController,
} from "../controllers/quoteController.js";

const router = express.Router();

// Stateless pricing — a read, because it stores nothing.
router.post("/price", authenticateAny, requireScope("quotes:read"), priceQuote);

router.post("/", authenticateAny, requireScope("quotes:write"), createQuoteController);
router.get("/", authenticateAny, requireScope("quotes:read"), listQuotesController);

// Last: a bare reference must not shadow /price.
router.get("/:reference", authenticateAny, requireScope("quotes:read"), getQuoteController);

export default router;
