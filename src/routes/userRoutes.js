// src/routes/userRoutes.js
import express from 'express';
import authenticate from '../middlewares/authMiddleware.js';
import { findUserById } from '../models/userModel.js';

const router = express.Router();

// for testing - returns current logged-in user details with role
router.get('/me', authenticate, async (req, res) => {
  try {
    const user = await findUserById(req.user.id);

    if (!user) return res.status(404).json({ message: 'User not found' });

    
    res.json({
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role_name,  // Example: 'admin' or 'agent'
      last_login: user.last_login
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error' });
  }
});

export default router;
