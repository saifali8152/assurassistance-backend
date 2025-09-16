// src/routes/userRoutes.js
import express from 'express';
import authenticate from '../middlewares/authMiddleware.js';
import { findUserById } from '../models/userModel.js';

const router = express.Router();

router.get('/me', authenticate, async (req, res) => {
  try {
    const user = await findUserById(req.user.id);
    if (!user) return res.status(404).json({ message: 'User not found' });
    res.json({ id: user.id, name: user.name, email: user.email, is_admin: !!user.is_admin, last_login: user.last_login });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error' });
  }
});

export default router;
