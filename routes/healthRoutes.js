// src/routes/healthRoutes.js
//
// Unauthenticated by design: an uptime monitor cannot hold a credential, and
// the payload carries nothing that is not safe for anyone to read.
//
import express from "express";
import { health, live } from "../controllers/healthController.js";

const router = express.Router();

router.get("/", health);
router.get("/live", live);

export default router;
