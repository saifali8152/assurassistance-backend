// src/routes/adminRoutes.js
import express from 'express';
import { createAgent, listAgents } from '../controllers/adminController.js';
import authenticate from '../middlewares/authMiddleware.js';
import { adminOnly } from '../middlewares/roleMiddleware.js';

const router = express.Router();

router.post('/agents', authenticate, adminOnly, createAgent);
router.get('/agents', authenticate, adminOnly, listAgents);

export default router;
