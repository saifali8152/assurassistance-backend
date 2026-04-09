// src/controllers/adminController.js
import bcrypt from 'bcryptjs';
import { createUser, findUserByEmail, getAllUsers, getAgents, findUserById, updateAgentProfile, getAgentAssignedPlanIds, setAgentAssignedPlans, getSubAgents, deleteAgentHierarchy } from '../models/userModel.js';
import crypto from 'crypto';
import { updateUserStatus } from '../models/userModel.js';
import getPool from '../utils/db.js';
import { generateStrongPassword } from '../utils/passwordUtils.js';
import sendEmail from '../utils/emailService.js';
import { agentWelcomeTemplate, passwordResetLinkTemplate } from '../utils/emailTemplates.js';

const REQUIRED_AGENT_FIELDS = ['company_name', 'partnership_type', 'country_of_residence', 'whatsapp_phone'];

export const createAgent = async (req, res) => {
  try {
    const {
      name, email, tempPassword,
      company_name, partnership_type, country_of_residence, whatsapp_phone,
      iata_number, geographical_location, work_phone,
      assigned_plan_ids
    } = req.body;
    if (!name || !email) return res.status(400).json({ message: 'Name and email are required' });
    for (const field of REQUIRED_AGENT_FIELDS) {
      const val = req.body[field];
      if (val == null || (typeof val === 'string' && val.trim() === '')) {
        return res.status(400).json({ message: `${field.replace(/_/g, ' ')} is required` });
      }
    }

    const exists = await findUserByEmail(email);
    if (exists) return res.status(400).json({ message: 'User with this email already exists' });

    // Generate strong password if tempPassword is not provided
    const password = tempPassword || generateStrongPassword(12);
    const hashed = await bcrypt.hash(password, 10);

    const userId = await createUser({
      name, email, password: hashed, role: 'agent', force_password_change: 1,
      company_name: company_name || null, partnership_type: partnership_type || null,
      country_of_residence: country_of_residence || null, whatsapp_phone: whatsapp_phone || null,
      iata_number: iata_number || null, geographical_location: geographical_location || null,
      work_phone: work_phone || null
    });

    if (assigned_plan_ids && Array.isArray(assigned_plan_ids) && assigned_plan_ids.length > 0) {
      await setAgentAssignedPlans(userId, assigned_plan_ids.map((id) => parseInt(id, 10)));
    }

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
    
    // Build WHERE clause for filtering (only main agents; sub-agents have parent_agent_id set)
    let whereClause = "WHERE u.role = 'agent' AND (u.parent_agent_id IS NULL OR u.parent_agent_id = 0)";
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
    
    // Get paginated results (include agent profile fields and assigned plan ids)
    const [agents] = await pool.query(`
      SELECT 
        u.id, u.name, u.email, u.status, u.created_at, u.force_password_change, u.last_login,
        u.company_name, u.partnership_type, u.country_of_residence, u.iata_number,
        u.geographical_location, u.work_phone, u.whatsapp_phone,
        GROUP_CONCAT(DISTINCT uap.catalogue_id) AS assigned_plan_ids,
        COUNT(DISTINCT c.id) as total_cases,
        COALESCE(SUM(DISTINCT s.received_amount), 0) as total_collected,
        MAX(a.activity_date) as last_activity
      FROM users u
      LEFT JOIN cases c ON c.created_by = u.id
      LEFT JOIN sales s ON s.case_id = c.id
      LEFT JOIN user_activity a ON a.user_id = u.id
      LEFT JOIN user_assigned_plans uap ON uap.user_id = u.id
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

const mapSubAgentRow = (s) => ({
  id: s.id,
  name: s.name,
  email: s.email,
  status: s.status,
  work_phone: s.work_phone,
  whatsapp_phone: s.whatsapp_phone,
  created_at: s.created_at,
  assigned_plan_ids: s.assigned_plan_ids ? String(s.assigned_plan_ids).split(',').map((x) => parseInt(x, 10)).filter((n) => !Number.isNaN(n)) : []
});

export const getAgent = async (req, res) => {
  try {
    const { id } = req.params;
    const user = await findUserById(id);
    if (!user || user.role_name !== 'agent') {
      return res.status(404).json({ message: 'Agent not found' });
    }
    const assigned_plan_ids = await getAgentAssignedPlanIds(parseInt(id, 10));
    const isSupervisor = user.parent_agent_id == null;
    let userType = 'supervisor';
    if (!isSupervisor) {
      const parent = await findUserById(user.parent_agent_id);
      userType = parent && parent.parent_agent_id == null ? 'agent' : 'sub_agent';
    }
    let sub_agents = [];
    if (isSupervisor) {
      const agents = await getSubAgents(parseInt(id, 10));
      sub_agents = await Promise.all(agents.map(async (a) => {
        const subList = await getSubAgents(a.id);
        return { ...mapSubAgentRow(a), type: 'agent', sub_agents: subList.map((s) => ({ ...mapSubAgentRow(s), type: 'sub_agent' })) };
      }));
    } else {
      const children = await getSubAgents(parseInt(id, 10));
      sub_agents = children.map((s) => ({ ...mapSubAgentRow(s), type: 'sub_agent' }));
    }
    res.json({
      success: true,
      data: {
        id: user.id,
        name: user.name,
        email: user.email,
        status: user.status,
        force_password_change: user.force_password_change,
        last_login: user.last_login,
        created_at: user.created_at,
        company_name: user.company_name,
        partnership_type: user.partnership_type,
        country_of_residence: user.country_of_residence,
        iata_number: user.iata_number,
        geographical_location: user.geographical_location,
        work_phone: user.work_phone,
        whatsapp_phone: user.whatsapp_phone,
        assigned_plan_ids,
        parent_agent_id: user.parent_agent_id,
        type: userType,
        sub_agents
      }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error' });
  }
};

export const updateAgent = async (req, res) => {
  try {
    const { id } = req.params;
    const user = await findUserById(id);
    if (!user || user.role_name !== 'agent') {
      return res.status(404).json({ message: 'Agent not found' });
    }
    const {
      name, company_name, partnership_type, country_of_residence, whatsapp_phone,
      iata_number, geographical_location, work_phone, assigned_plan_ids
    } = req.body;
    const updates = {};
    if (name !== undefined) updates.name = name;
    if (company_name !== undefined) updates.company_name = company_name;
    if (partnership_type !== undefined) updates.partnership_type = partnership_type;
    if (country_of_residence !== undefined) updates.country_of_residence = country_of_residence;
    if (whatsapp_phone !== undefined) updates.whatsapp_phone = whatsapp_phone;
    if (iata_number !== undefined) updates.iata_number = iata_number;
    if (geographical_location !== undefined) updates.geographical_location = geographical_location;
    if (work_phone !== undefined) updates.work_phone = work_phone;
    if (Object.keys(updates).length > 0) {
      await updateAgentProfile(parseInt(id, 10), updates);
    }
    if (assigned_plan_ids !== undefined && Array.isArray(assigned_plan_ids)) {
      await setAgentAssignedPlans(parseInt(id, 10), assigned_plan_ids.map((x) => parseInt(x, 10)));
    }
    res.json({ success: true, message: 'Agent updated successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error' });
  }
};

export const listSubAgents = async (req, res) => {
  try {
    const { id } = req.params;
    const parent = await findUserById(id);
    if (!parent || parent.role_name !== 'agent') {
      return res.status(404).json({ message: 'Agent not found' });
    }
    const subAgents = await getSubAgents(parseInt(id, 10));
    const withPlanIds = await Promise.all(
      subAgents.map(async (s) => {
        const planIds = await getAgentAssignedPlanIds(s.id);
        return {
          id: s.id,
          name: s.name,
          email: s.email,
          status: s.status,
          work_phone: s.work_phone,
          whatsapp_phone: s.whatsapp_phone,
          created_at: s.created_at,
          assigned_plan_ids: planIds
        };
      })
    );
    res.json({ success: true, data: withPlanIds });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error' });
  }
};

const REQUIRED_SUB_AGENT_FIELDS = ['first_name', 'last_name', 'email', 'whatsapp_phone', 'assigned_plan_ids'];

export const createSubAgent = async (req, res) => {
  try {
    const { id } = req.params;
    const parent = await findUserById(id);
    if (!parent || parent.role_name !== 'agent') {
      return res.status(404).json({ message: 'Agent not found' });
    }
    const { first_name, last_name, email, work_phone, whatsapp_phone, assigned_plan_ids } = req.body;
    const name = [first_name, last_name].filter(Boolean).map((s) => (s || '').trim()).join(' ').trim();
    if (!name || !email || !whatsapp_phone) {
      return res.status(400).json({ message: 'First name, last name, email and WhatsApp phone are required' });
    }
    if (!assigned_plan_ids || !Array.isArray(assigned_plan_ids) || assigned_plan_ids.length === 0) {
      return res.status(400).json({ message: 'At least one assigned plan is required' });
    }
    const exists = await findUserByEmail(email);
    if (exists) return res.status(400).json({ message: 'User with this email already exists' });

    const password = generateStrongPassword(12);
    const hashed = await bcrypt.hash(password, 10);
    const agentId = parseInt(id, 10);

    const userId = await createUser({
      name,
      email: email.trim(),
      password: hashed,
      role: 'agent',
      force_password_change: 1,
      company_name: null,
      partnership_type: null,
      country_of_residence: null,
      iata_number: null,
      geographical_location: null,
      work_phone: (work_phone && work_phone.trim()) || null,
      whatsapp_phone: whatsapp_phone.trim(),
      parent_agent_id: agentId
    });

    await setAgentAssignedPlans(userId, assigned_plan_ids.map((x) => parseInt(x, 10)));

    try {
      const loginUrl = `${process.env.FRONTEND_URL || 'https://acareeracademy.com'}/login`;
      const emailTemplate = agentWelcomeTemplate(name, password, loginUrl);
      await sendEmail(email.trim(), emailTemplate.subject, emailTemplate.text, emailTemplate.html);
    } catch (emailErr) {
      console.error('Failed to send welcome email to sub-agent:', emailErr);
    }

    res.status(201).json({
      success: true,
      data: { id: userId, email: email.trim(), tempPassword: password },
      message: 'Sub-agent created successfully. Welcome email sent.'
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error' });
  }
};

/** DELETE /admin/agents/:id — delete supervisor (whole tree), agent (+ sub-agents), or sub-agent only */
export const deleteAgentOrHierarchy = async (req, res) => {
  try {
    const { id } = req.params;
    const result = await deleteAgentHierarchy(id);
    if (!result.ok) {
      return res.status(404).json({ success: false, message: result.message || 'Agent not found or cannot be deleted' });
    }
    res.json({
      success: true,
      message: `Deleted ${result.deletedCount} user account(s) and related cases.`,
      deletedCount: result.deletedCount
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error during delete' });
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

const MONTH_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Daily points for the current calendar month (all days 1..last day; empty days = 0). */
async function buildCurrentMonthTrend(pool) {
  const [rows] = await pool.query(
    `SELECT 
        DAY(confirmed_at) AS day_of_month,
        COUNT(*) AS sales_count,
        SUM(s.total) AS total_amount,
        SUM(COALESCE(s.received_amount, 0)) AS collected_amount
      FROM sales s
      WHERE s.confirmed_at >= DATE_FORMAT(NOW(), '%Y-%m-01')
        AND s.confirmed_at < DATE_ADD(DATE_FORMAT(NOW(), '%Y-%m-01'), INTERVAL 1 MONTH)
      GROUP BY DAY(confirmed_at)
      ORDER BY day_of_month`
  );

  const byDay = new Map();
  for (const r of rows) {
    const d = Number(r.day_of_month);
    byDay.set(d, {
      salesCount: Number(r.sales_count) || 0,
      totalAmount: Number(r.total_amount) || 0,
      collectedAmount: Number(r.collected_amount) || 0
    });
  }

  const now = new Date();
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const out = [];
  for (let day = 1; day <= daysInMonth; day++) {
    const pt = byDay.get(day) || { salesCount: 0, totalAmount: 0, collectedAmount: 0 };
    out.push({
      periodLabel: String(day),
      day,
      salesCount: pt.salesCount,
      totalAmount: pt.totalAmount,
      collectedAmount: pt.collectedAmount
    });
  }
  return out;
}

/** Monthly points for the current calendar year (Jan–Dec; months with no sales = 0). */
async function buildCurrentYearTrend(pool) {
  const [rows] = await pool.query(
    `SELECT 
        MONTH(confirmed_at) AS month_num,
        COUNT(*) AS sales_count,
        SUM(s.total) AS total_amount,
        SUM(COALESCE(s.received_amount, 0)) AS collected_amount
      FROM sales s
      WHERE YEAR(s.confirmed_at) = YEAR(NOW())
      GROUP BY MONTH(confirmed_at)
      ORDER BY month_num`
  );

  const byMonth = new Map();
  for (const r of rows) {
    const m = Number(r.month_num);
    byMonth.set(m, {
      salesCount: Number(r.sales_count) || 0,
      totalAmount: Number(r.total_amount) || 0,
      collectedAmount: Number(r.collected_amount) || 0
    });
  }

  const out = [];
  for (let m = 1; m <= 12; m++) {
    const pt = byMonth.get(m) || { salesCount: 0, totalAmount: 0, collectedAmount: 0 };
    out.push({
      periodLabel: MONTH_SHORT[m - 1],
      month: m,
      salesCount: pt.salesCount,
      totalAmount: pt.totalAmount,
      collectedAmount: pt.collectedAmount
    });
  }
  return out;
}

/** Sales volume, number of policies (sales count), and collections — current month (daily) and current year (monthly). */
export const getProductionTrend = async (req, res) => {
  try {
    const pool = getPool();
    const [currentMonth, currentYear] = await Promise.all([buildCurrentMonthTrend(pool), buildCurrentYearTrend(pool)]);

    res.json({
      success: true,
      data: {
        currentMonth,
        currentYear
      }
    });
  } catch (error) {
    console.error("Error fetching production trend:", error);
    res.status(500).json({ success: false, message: "Error fetching production trend" });
  }
};