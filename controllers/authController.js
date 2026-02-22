import sendEmail from "../utils/emailService.js";
import { passwordResetOtpTemplate } from "../utils/emailTemplates.js";
import { logActivity } from "../models/activityModel.js";
import {
  findUserByEmail,
  updateLastLogin,
  updatePassword,
} from "../models/userModel.js";
import generateToken from "../utils/generateToken.js";
import {
  validatePasswordStrength,
  hashPassword,
  verifyPassword,
  isPasswordCompromised,
} from "../utils/passwordUtils.js";
import getPool from "../utils/db.js";
export const login = async (req, res) => {
  try {
    const email = req.body.email.toLowerCase();
    const password = req.body.password;
    if (!email || !password)
      return res.status(400).json({ message: "Email and password required" });

    const user = await findUserByEmail(email);
    if (!user) return res.status(401).json({ message: "Email does not exist" });

    const isMatch = await verifyPassword(password, user.password);
    if (!isMatch)
      return res.status(401).json({ message: "Password is incorrect" });
    if (user.status != "active")
      return res.status(401).json({ message: "Your access to the system has been revoked. For further assistance, please contact your company administrator." });

    await updateLastLogin(user.id);

    // Generate JWT token
    const token = generateToken(user);

    await logActivity(user.id, "Login");

    // Send response
    res.json({
      token,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role_name,
        force_password_change: !!user.force_password_change,
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
};

//change password

export const changePassword = async (req, res) => {
  try {
    const userId = req.user.id;
    const { oldPassword, newPassword, confirmPassword } = req.body;
    if (!oldPassword || !newPassword || !confirmPassword)
      return res
        .status(400)
        .json({ message: "oldPassword, newPassword, and confirmPassword are required" });

    // Validate that new password and confirm password match
    if (newPassword !== confirmPassword) {
      return res
        .status(400)
        .json({ message: "New password and confirm password do not match" });
    }

    // Validate new password strength
    const passwordValidation = validatePasswordStrength(newPassword);
    if (!passwordValidation.isValid) {
      return res.status(400).json({
        message: "Password does not meet requirements",
        errors: passwordValidation.errors,
      });
    }

    // Check if password is compromised
    if (isPasswordCompromised(newPassword)) {
      return res
        .status(400)
        .json({ message: "Password is too weak or has been compromised" });
    }

    const user = await findUserByEmail(req.user.email);
    if (!user) return res.status(404).json({ message: "User not found" });

    const isMatch = await verifyPassword(oldPassword, user.password);
    if (!isMatch)
      return res.status(400).json({ message: "Old password incorrect" });

    // Check if new password is same as old password
    if (oldPassword === newPassword) {
      return res
        .status(400)
        .json({
          message: "New password must be different from current password",
        });
    }

    const hashed = await hashPassword(newPassword);
    await updatePassword(userId, hashed);

    // Get updated user data to return the new force_password_change status
    const updatedUser = await findUserByEmail(req.user.email);
    
    res.json({ 
      message: "Password updated successfully",
      user: {
        id: updatedUser.id,
        name: updatedUser.name,
        email: updatedUser.email,
        role: updatedUser.role_name,
        force_password_change: !!updatedUser.force_password_change,
      }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
};

export const forgotPassword = async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ message: "Email is required" });

    // Check if user exists
    const pool = getPool();
    const [user] = await pool.query("SELECT * FROM users WHERE email = ?", [
      email,
    ]);
    if (user.length === 0)
      return res.status(404).json({ message: "User not found" });

    // Generate OTP (6 digits)
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 min

    // Store OTP in DB
    await pool.query(
      "INSERT INTO password_resets (email, otp, expires_at) VALUES (?, ?, ?)",
      [email, otp, expiresAt]
    );

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
    const { email, code, newPassword, confirmPassword } = req.body;
    const otp = code;
    if (!email || !otp || !newPassword || !confirmPassword)
      return res.status(400).json({ message: "All fields required" });

    // Validate that new password and confirm password match
    if (newPassword !== confirmPassword) {
      return res
        .status(400)
        .json({ message: "New password and confirm password do not match" });
    }

    // Verify OTP
    const pool = getPool();
    const [rows] = await pool.query(
      "SELECT * FROM password_resets WHERE email = ? AND otp = ? AND expires_at > NOW() ORDER BY id DESC LIMIT 1",
      [email, otp]
    );

    if (rows.length === 0)
      return res.status(400).json({ message: "Invalid or expired OTP" });

    // Validate new password strength
    const passwordValidation = validatePasswordStrength(newPassword);
    if (!passwordValidation.isValid) {
      return res.status(400).json({
        message: "Password does not meet requirements",
        errors: passwordValidation.errors,
      });
    }

    // Check if password is compromised
    if (isPasswordCompromised(newPassword)) {
      return res
        .status(400)
        .json({ message: "Password is too weak or has been compromised" });
    }

    // Hash new password
    const hashed = await hashPassword(newPassword);
    await pool.query("UPDATE users SET password = ?, force_password_change = 0 WHERE email = ?", [
      hashed,
      email,
    ]);

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
    const pool = getPool();
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

// Logout endpoint
export const logout = async (req, res) => {
  try {
    const userId = req.user.id;
    
    // Log the logout activity
    await logActivity(userId, "Logout");
    res.clearCookie('token');
    
    res.json({ message: "Logged out successfully" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
};
