// src/routes/adminRoutes.js
import express from 'express';
import { createAgent, listAgents, getAgent, updateAgent, changeUserStatus, getAdminDashboardStats, getProductionTrend, sendPasswordResetLink } from '../controllers/adminController.js';
import authenticate from '../middlewares/authMiddleware.js';
import { adminOnly } from '../middlewares/roleMiddleware.js';
import { findUserById } from '../models/userModel.js';
import getPool from '../utils/db.js';

const router = express.Router();

// adminRoutes.js
router.post('/create-agent', authenticate, adminOnly, createAgent);
router.get('/list-agents', authenticate, adminOnly, listAgents);
router.get('/agents/:id', authenticate, adminOnly, getAgent);
router.patch('/agents/:id', authenticate, adminOnly, updateAgent);
router.patch('/users/status', changeUserStatus);
router.post('/send-reset-link', authenticate, adminOnly, sendPasswordResetLink);
router.get("/dashboard", getAdminDashboardStats);
router.get("/production-trend", authenticate, adminOnly, getProductionTrend);

// Get admin profile
router.get('/profile', authenticate, async (req, res) => {
  try {
    const userId = req.user.id;
    const user = await findUserById(userId);
    
    if (!user) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    res.json({
      success: true,
      data: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role_name,
        created_at: user.created_at,
        last_login: user.last_login
      }
    });
  } catch (error) {
    console.error("Error fetching admin profile:", error);
    res.status(500).json({ success: false, message: "Error fetching profile" });
  }
});

// Update admin profile
router.patch('/profile', authenticate, async (req, res) => {
  try {
    const userId = req.user.id;
    const { name } = req.body;
    
    if (!name || name.trim() === '') {
      return res.status(400).json({ success: false, message: "Name is required" });
    }

    const pool = getPool();
    await pool.query(
      'UPDATE users SET name = ? WHERE id = ?',
      [name.trim(), userId]
    );
    res.json({
      success: true,
      message: "Profile updated successfully"
    });
  } catch (error) {
    console.error("Error updating admin profile:", error);
    res.status(500).json({ success: false, message: "Error updating profile" });
  }
});

// Change admin password
router.patch('/change-password', authenticate, async (req, res) => {
  try {
    const userId = req.user.id;
    const { currentPassword, newPassword } = req.body;
    
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ success: false, message: "Current password and new password are required" });
    }

    if (newPassword.length < 6) {
      return res.status(400).json({ success: false, message: "New password must be at least 6 characters long" });
    }

    const pool = getPool();
    
    // Get current user with password
    const [users] = await pool.query(
      'SELECT id, password FROM users WHERE id = ?',
      [userId]
    );
    
    if (users.length === 0) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    const user = users[0];
    
    // Verify current password
    const bcrypt = await import('bcryptjs');
    const isCurrentPasswordValid = await bcrypt.compare(currentPassword, user.password);
    
    if (!isCurrentPasswordValid) {
      return res.status(400).json({ success: false, message: "Current password is incorrect" });
    }

    // Hash new password
    const hashedNewPassword = await bcrypt.hash(newPassword, 10);
    
    // Update password
    await pool.query(
      'UPDATE users SET password = ?, force_password_change = 0 WHERE id = ?',
      [hashedNewPassword, userId]
    );

    res.json({
      success: true,
      message: "Password changed successfully"
    });
  } catch (error) {
    console.error("Error changing admin password:", error);
    res.status(500).json({ success: false, message: "Error changing password" });
  }
});

export default router;
