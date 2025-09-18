// src/routes/adminRoutes.js
import express from 'express';
import { createAgent, listAgents, changeUserStatus  } from '../controllers/adminController.js';
import authenticate from '../middlewares/authMiddleware.js';
import { adminOnly } from '../middlewares/roleMiddleware.js';

const router = express.Router();

// adminRoutes.js
router.post('/create-agent', authenticate, adminOnly, createAgent);
router.get('/list-agents', authenticate, adminOnly, listAgents);
router.patch('/users/status', changeUserStatus);
export default router;
