// src/routes/authRoutes.js
import express from 'express';
import { login, changePassword } from '../controllers/authController.js';
import authenticate from '../middlewares/authMiddleware.js';

const router = express.Router();
//routes
router.post('/login', login);
router.post('/change-password', authenticate, changePassword);

export default router;


