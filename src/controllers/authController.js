import sendEmail from '../utils/emailService.js';
import { loginNotificationTemplate } from '../utils/emailTemplates.js';
import bcrypt from 'bcryptjs';
import { findUserByEmail, updateLastLogin, updatePassword } from '../models/userModel.js';
import generateToken from '../utils/generateToken.js';

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
