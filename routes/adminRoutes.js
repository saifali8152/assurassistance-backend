// src/routes/adminRoutes.js
import express from 'express';
import {
  createAgent,
  listAgents,
  getAgent,
  updateAgent,
  listSubAgents,
  createSubAgent,
  deleteAgentOrHierarchy,
  changeUserStatus,
  getAdminDashboardStats,
  getProductionTrend,
  sendPasswordResetLink,
  listAgentHierarchy,
  exportAgentHierarchyCsv,
  createSubAdmin,
  listSubAdmins,
  deleteSubAdmin,
  createInsurerSupervisor,
  listInsurerSupervisors,
  deleteInsurerSupervisor,
  listPartnerInsurers,
  listPartners,
  reassignAgentSupervisor,
  getAgentSupervisionHistory,
  checkEmailAvailable
} from '../controllers/adminController.js';
import authenticate from '../middlewares/authMiddleware.js';
import { adminOnly, adminOrAgencyManager } from '../middlewares/roleMiddleware.js';
import { findUserById } from '../models/userModel.js';
import getPool from '../utils/db.js';

const router = express.Router();

// Agency-management endpoints: admin, sub-admin, or insurer supervisor.
router.post('/create-agent', authenticate, adminOrAgencyManager, createAgent);
router.get('/list-agents', authenticate, adminOrAgencyManager, listAgents);
router.get('/email-available', authenticate, adminOrAgencyManager, checkEmailAvailable);
// Superadmin: partners (agencies) listed once by partnership type, with descendant account counts.
router.get('/partners', authenticate, adminOnly, listPartners);
router.get('/agent-hierarchy/export', authenticate, adminOnly, exportAgentHierarchyCsv);
router.get('/agent-hierarchy', authenticate, adminOnly, listAgentHierarchy);
router.get('/agents/:id', authenticate, adminOrAgencyManager, getAgent);
router.patch('/agents/:id', authenticate, adminOrAgencyManager, updateAgent);
router.delete('/agents/:id', authenticate, adminOrAgencyManager, deleteAgentOrHierarchy);
// Admin-only: reassign partner/agency to another sub-admin (keeps historical sales/policies).
router.patch('/agents/:id/supervisor', authenticate, adminOnly, reassignAgentSupervisor);
router.get('/agents/:id/supervision-history', authenticate, adminOnly, getAgentSupervisionHistory);
router.get('/agents/:id/sub-agents', authenticate, adminOrAgencyManager, listSubAgents);
router.post('/agents/:id/sub-agents', authenticate, adminOrAgencyManager, createSubAgent);
router.patch('/users/status', authenticate, adminOrAgencyManager, changeUserStatus);
router.post('/send-reset-link', authenticate, adminOrAgencyManager, sendPasswordResetLink);
router.get('/dashboard', authenticate, adminOrAgencyManager, getAdminDashboardStats);
router.get('/production-trend', authenticate, adminOnly, getProductionTrend);

// Sub-administrator management is admin-only.
router.post('/create-sub-admin', authenticate, adminOnly, createSubAdmin);
router.get('/sub-admins', authenticate, adminOnly, listSubAdmins);
router.delete('/sub-admins/:id', authenticate, adminOnly, deleteSubAdmin);

// Insurer supervisor management is admin-only.
router.get('/partner-insurers', authenticate, adminOnly, listPartnerInsurers);
router.post('/create-insurer-supervisor', authenticate, adminOnly, createInsurerSupervisor);
router.get('/insurer-supervisors', authenticate, adminOnly, listInsurerSupervisors);
router.delete('/insurer-supervisors/:id', authenticate, adminOnly, deleteInsurerSupervisor);

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
