// src/routes/authRoutes.js
import express from 'express';
import { login, changePassword , forgotPassword, resetPassword, verifyResetCode} from '../controllers/authController.js';
import authenticate from '../middlewares/authMiddleware.js';

const router = express.Router();
//routes
router.post('/login', login);
router.post('/change-password', authenticate, changePassword);

router.post('/forgot-password', forgotPassword);
router.post('/reset-password', resetPassword);
router.post('/verify-reset-code', verifyResetCode); 
export default router;


