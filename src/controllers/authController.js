import sendEmail from '../utils/emailService.js';
import { loginNotificationTemplate,passwordResetOtpTemplate  } from '../utils/emailTemplates.js';
import bcrypt from 'bcryptjs';
import { findUserByEmail, updateLastLogin, updatePassword } from '../models/userModel.js';
import generateToken from '../utils/generateToken.js';
import pool from "../db.js";
export const login = async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password)
      return res.status(400).json({ message: 'Email and password required' });

    const user = await findUserByEmail(email);
    if (!user) return res.status(401).json({ message: 'Invalid credentials' });

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) return res.status(401).json({ message: 'Invalid credentials' });

    // Update last login
    try { await updateLastLogin(user.id); } catch (e) { /* ignore */ }

    // Generate JWT token
    const token = generateToken(user);

    // Send Login Notification Email
    try {
      const { subject, text, html } = loginNotificationTemplate(user.name, new Date().toLocaleString());
      await sendEmail(user.email, subject, text, html);
    } catch (emailErr) {
      console.error('Email sending failed:', emailErr.message);
      // Do not break login flow if email fails
    }

    // Send response
    res.json({
      token,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role_name,
        force_password_change: !!user.force_password_change
      }
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error' });
  }
};


//change password

export const changePassword = async (req, res) => {
  try {
    const userId = req.user.id;
    const { oldPassword, newPassword } = req.body;
    if (!oldPassword || !newPassword) return res.status(400).json({ message: 'oldPassword and newPassword required' });

    const user = await findUserByEmail(req.user.email);
    if (!user) return res.status(404).json({ message: 'User not found' });

    const isMatch = await bcrypt.compare(oldPassword, user.password);
    if (!isMatch) return res.status(400).json({ message: 'Old password incorrect' });

    const hashed = await bcrypt.hash(newPassword, 10);
    await updatePassword(userId, hashed);

    res.json({ message: 'Password updated successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error' });
  }
};

export const forgotPassword = async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ message: "Email is required" });

    // Check if user exists
    const [user] = await pool.query("SELECT * FROM users WHERE email = ?", [email]);
    if (user.length === 0) return res.status(404).json({ message: "User not found" });

    // Generate OTP (6 digits)
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 min

    // Store OTP in DB
    await pool.query("INSERT INTO password_resets (email, otp, expires_at) VALUES (?, ?, ?)", [email, otp, expiresAt]);

    // Send email
    const { subject, text, html } = passwordResetOtpTemplate(otp);
    await sendEmail(email, subject, text, html);

    res.json({ message: "OTP sent to your email" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
};

export const resetPassword = async (req, res) => {
  try {
    const { email, code, newPassword } = req.body;
    const otp=code;
    if (!email || !otp || !newPassword) return res.status(400).json({ message: "All fields required" });

    // Verify OTP
    const [rows] = await pool.query(
      "SELECT * FROM password_resets WHERE email = ? AND otp = ? AND expires_at > NOW() ORDER BY id DESC LIMIT 1",
      [email, otp]
    );

    if (rows.length === 0) return res.status(400).json({ message: "Invalid or expired OTP" });

    // Hash new password
    const hashed = await bcrypt.hash(newPassword, 10);
    await pool.query("UPDATE users SET password = ? WHERE email = ?", [hashed, email]);

    // Delete used OTP
    await pool.query("DELETE FROM password_resets WHERE email = ?", [email]);

    res.json({ message: "Password reset successful" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
};

export const verifyResetCode = async (req, res) => {
  const { email, code } = req.body;
  try {
    const [rows] = await pool.query(
      "SELECT * FROM password_resets WHERE email = ? AND otp = ? AND expires_at > NOW() ORDER BY id DESC LIMIT 1",
      [email, code]
    );

    if (rows.length === 0) {
      return res.status(400).json({ message: "Invalid or expired code" });
    }

    // Code is valid
    res.json({ message: "Code verified successfully" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
};
