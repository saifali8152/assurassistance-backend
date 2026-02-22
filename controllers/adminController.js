// src/controllers/adminController.js
import bcrypt from 'bcryptjs';
import { createUser, findUserByEmail, getAllUsers, getAgents } from '../models/userModel.js';
import crypto from 'crypto';
import { updateUserStatus } from '../models/userModel.js';
import getPool from '../utils/db.js';
import { generateStrongPassword } from '../utils/passwordUtils.js';
import sendEmail from '../utils/emailService.js';
import { agentWelcomeTemplate, passwordResetLinkTemplate } from '../utils/emailTemplates.js';

export const createAgent = async (req, res) => {
  try {
    const { name, email, tempPassword } = req.body;
    if (!name || !email) return res.status(400).json({ message: 'Name and email are required' });

    const exists = await findUserByEmail(email);
    if (exists) return res.status(400).json({ message: 'User with this email already exists' });

    // Generate strong password if tempPassword is not provided
    const password = tempPassword || generateStrongPassword(12);
    const hashed = await bcrypt.hash(password, 10);

    // role for Agent is 'agent'
    const userId = await createUser({ name, email, password: hashed, role: 'agent', force_password_change: 1 });

    // Send welcome email to agent
    try {
      const loginUrl = `${process.env.FRONTEND_URL || 'https://acareeracademy.com'}/login`;
      const emailTemplate = agentWelcomeTemplate(name, password, loginUrl);
      
      await sendEmail(
        email,
        emailTemplate.subject,
        emailTemplate.text,
        emailTemplate.html
      );
    } catch (emailError) {
      console.error('Failed to send welcome email:', emailError);
      // Don't fail the agent creation if email fails
    }

    res.status(201).json({ 
      id: userId, 
      email, 
      tempPassword: password, 
      message: 'Agent created successfully. Welcome email sent to agent.' 
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error' });
  }
};



export const listAgents = async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const search = req.query.search || '';
    const status = req.query.status || '';
    
    const offset = (page - 1) * limit;
    
    const pool = getPool();
    
    // Build WHERE clause for filtering
    let whereClause = "WHERE u.role = 'agent'";
    const params = [];
    
    if (search) {
      whereClause += " AND (u.name LIKE ? OR u.email LIKE ?)";
      params.push(`%${search}%`, `%${search}%`);
    }
    
    if (status) {
      whereClause += " AND u.status = ?";
      params.push(status);
    }
    
    // Get total count
    const [[{ total }]] = await pool.query(
      `SELECT COUNT(*) as total FROM users u ${whereClause}`,
      params
    );
    
    // Get paginated results
    const [agents] = await pool.query(`
      SELECT 
        u.id, u.name, u.email, u.status, u.created_at, u.force_password_change,u.last_login,
        COUNT(c.id) as total_cases,
        SUM(s.received_amount) as total_collected,
        MAX(a.activity_date) as last_activity
      FROM users u
      LEFT JOIN cases c ON c.created_by = u.id
      LEFT JOIN sales s ON s.case_id = c.id
      LEFT JOIN user_activity a ON a.user_id = u.id
      ${whereClause}
      GROUP BY u.id
      ORDER BY u.created_at DESC
      LIMIT ? OFFSET ?
    `, [...params, limit, offset]);
    
    const totalPages = Math.ceil(total / limit);
    
    res.json({
      success: true,
      data: {
        agents,
        pagination: {
          currentPage: page,
          totalPages,
          totalItems: total,
          itemsPerPage: limit,
          hasNextPage: page < totalPages,
          hasPrevPage: page > 1
        }
      }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error' });
  }
};

export const changeUserStatus = async (req, res) => {
  try {
    const { userId, status } = req.body;
    if (!userId || !status) return res.status(400).json({ message: "User ID and status required" });

    await updateUserStatus(userId, status);
    res.json({ message: `User status updated to ${status}` });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
};

export const sendPasswordResetLink = async (req, res) => {
  try {
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ message: "User ID required" });

    const pool = getPool();
    
    // Get user details
    const [users] = await pool.query(
      'SELECT id, name, email FROM users WHERE id = ? AND role = "agent"',
      [userId]
    );
    
    if (users.length === 0) {
      return res.status(404).json({ message: "Agent not found" });
    }
    
    const user = users[0];
    
    // Generate new temporary password
    const tempPassword = generateStrongPassword(12);
    const hashedPassword = await bcrypt.hash(tempPassword, 10);
    
    // Update user with new temporary password and force password change
    await pool.query(
      'UPDATE users SET password = ?, force_password_change = 1 WHERE id = ?',
      [hashedPassword, userId]
    );
    
    // Send email with new temporary password
    try {
      const loginUrl = `${process.env.FRONTEND_URL || 'https://acareeracademy.com'}/login`;
      const emailTemplate = agentWelcomeTemplate(user.name, tempPassword, loginUrl);
      
      await sendEmail(
        user.email,
        emailTemplate.subject,
        emailTemplate.text,
        emailTemplate.html
      );
      
      res.json({ 
        success: true,
        message: `New temporary password sent to ${user.email}`,
        tempPassword: tempPassword // Include temp password in response for admin reference
      });
    } catch (emailError) {
      console.error('Failed to send password reset email:', emailError);
      res.status(500).json({ message: 'Failed to send password reset email' });
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
};

// ...existing code...
export const getAdminDashboardStats = async (req, res) => {
  try {
    const pool = getPool();
    
    // Total Sales
    const [[{ total_sales = 0 } = {}]] = await pool.query(
      `SELECT COUNT(*) as total_sales FROM sales`
    );

    // Gross Collected
    const [[{ gross_collected = 0 } = {}]] = await pool.query(
      `SELECT SUM(received_amount) as gross_collected FROM sales`
    );

    // Unpaid Balance
    const [[{ unpaid_balance = 0 } = {}]] = await pool.query(
      `SELECT SUM(total - received_amount) as unpaid_balance FROM sales`
    );

    // Active Users (last 7 days)
    const [[{ active_users = 0 } = {}]] = await pool.query(
      `SELECT COUNT(DISTINCT user_id) AS active_users
       FROM user_activity
       WHERE activity_date >= DATE_SUB(NOW(), INTERVAL 7 DAY)`
    );

    // Recent Sales (last 5 sales from all agents)
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
        cat.product_type,
        u.name as created_by_name
      FROM sales s
      JOIN cases c ON s.case_id = c.id
      JOIN travellers t ON c.traveller_id = t.id
      LEFT JOIN catalogue cat ON c.selected_plan_id = cat.id
      LEFT JOIN users u ON c.created_by = u.id
      ORDER BY s.confirmed_at DESC
      LIMIT 5
    `);

    res.json({
      success: true,
      data: {
        totalSales: Number(total_sales) || 0,
        grossCollected: Number(gross_collected) || 0,
        unpaidBalance: Number(unpaid_balance) || 0,
        activeUsers: Number(active_users) || 0,
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
          product_type: s.product_type || "",
          created_by_name: s.created_by_name || ""
        }))
      }
    });
  } catch (error) {
    console.error("Error fetching dashboard stats:", error);
    res.status(500).json({ success: false, message: "Error fetching stats" });
  }
};

// Get production trend data (monthly sales for the last 12 months)
export const getProductionTrend = async (req, res) => {
  try {
    const pool = getPool();
    
    const [trendData] = await pool.query(`
      SELECT 
        DATE_FORMAT(confirmed_at, '%Y-%m') as month,
        DATE_FORMAT(confirmed_at, '%b %Y') as month_label,
        COUNT(*) as sales_count,
        SUM(total) as total_amount,
        SUM(received_amount) as collected_amount
      FROM sales
      WHERE confirmed_at >= DATE_SUB(NOW(), INTERVAL 12 MONTH)
      GROUP BY DATE_FORMAT(confirmed_at, '%Y-%m'), DATE_FORMAT(confirmed_at, '%b %Y')
      ORDER BY month ASC
    `);

    res.json({
      success: true,
      data: trendData.map(row => ({
        month: row.month,
        monthLabel: row.month_label,
        salesCount: Number(row.sales_count) || 0,
        totalAmount: Number(row.total_amount) || 0,
        collectedAmount: Number(row.collected_amount) || 0
      }))
    });
  } catch (error) {
    console.error("Error fetching production trend:", error);
    res.status(500).json({ success: false, message: "Error fetching production trend" });
  }
};