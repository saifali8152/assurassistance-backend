// src/routes/userRoutes.js
import express from 'express';
import authenticate from '../middlewares/authMiddleware.js';
import { findUserById, getAgentVisibilityIds } from '../models/userModel.js';
import getPool from '../utils/db.js';

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

// Agent dashboard - get recent sales for the logged-in agent (and sub-agents if main agent)
router.get('/dashboard', authenticate, async (req, res) => {
  try {
    const agentIds = await getAgentVisibilityIds(req.user.id);
    const pool = getPool();
    const placeholders = agentIds.map(() => '?').join(',');
    
    const [recentSales] = await pool.query(`
      SELECT 
        s.id as sale_id,
        s.case_id,
        s.policy_number,
        s.certificate_number,
        s.total,
        s.received_amount,
        s.payment_status,
        s.confirmed_at,
        CONCAT(t.first_name, ' ', t.last_name) as traveller_name,
        t.phone as traveller_phone,
        cat.name as plan_name,
        cat.product_type
      FROM sales s
      JOIN cases c ON s.case_id = c.id
      JOIN travellers t ON c.traveller_id = t.id
      LEFT JOIN catalogue cat ON c.selected_plan_id = cat.id
      WHERE c.created_by IN (${placeholders})
      ORDER BY s.confirmed_at DESC
      LIMIT 5
    `, agentIds);

    res.json({
      success: true,
      data: {
        recentSales: recentSales.map(s => ({
          sale_id: s.sale_id,
          case_id: s.case_id,
          policy_number: s.policy_number || "",
          certificate_number: s.certificate_number || "",
          total: s.total || 0,
          received_amount: s.received_amount || 0,
          payment_status: s.payment_status || "",
          confirmed_at: s.confirmed_at ? new Date(s.confirmed_at).toLocaleString() : "",
          traveller_name: s.traveller_name || "",
          traveller_phone: s.traveller_phone || "",
          plan_name: s.plan_name || "",
          product_type: s.product_type || ""
        }))
      }
    });
  } catch (error) {
    console.error("Error fetching agent dashboard:", error);
    res.status(500).json({ success: false, message: "Error fetching dashboard data" });
  }
});

// Get user profile
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
    console.error("Error fetching user profile:", error);
    res.status(500).json({ success: false, message: "Error fetching profile" });
  }
});

// Update user profile
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
    console.error("Error updating profile:", error);
    res.status(500).json({ success: false, message: "Error updating profile" });
  }
});

// Change password
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
    console.error("Error changing password:", error);
    res.status(500).json({ success: false, message: "Error changing password" });
  }
});

export default router;
