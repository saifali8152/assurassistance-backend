// src/routes/adminRoutes.js
import express from 'express';
import { createAgent, listAgents } from '../controllers/adminController.js';
import authenticate from '../middlewares/authMiddleware.js';
import { adminOnly } from '../middlewares/roleMiddleware.js';

const router = express.Router();

// adminRoutes.js
router.post('/create-agent', authenticate, adminOnly, createAgent);
router.get('/list-agents', authenticate, adminOnly, listAgents);

export default router;
