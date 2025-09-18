// src/controllers/adminController.js
import bcrypt from 'bcryptjs';
import { createUser, findUserByEmail, getAllUsers, getAgents } from '../models/userModel.js';
import crypto from 'crypto';
import { updateUserStatus } from '../models/userModel.js';

import { generateStrongPassword } from '../utils/passwordUtils.js';

export const createAgent = async (req, res) => {
  try {
    const { name, email, tempPassword } = req.body;
    if (!name || !email) return res.status(400).json({ message: 'Name and email are required' });

    const exists = await findUserByEmail(email);
    if (exists) return res.status(400).json({ message: 'User with this email already exists' });

    // Generate strong password if tempPassword is not provided
    const password = tempPassword || generateStrongPassword(12);
    const hashed = await bcrypt.hash(password, 10);

    // role_id for Agent is 2
    const userId = await createUser({ name, email, password: hashed, role_id: 2, force_password_change: 1 });

    res.status(201).json({ 
      id: userId, 
      email, 
      tempPassword: password, 
      message: 'Agent created. Share the tempPassword with agent' 
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error' });
  }
};



export const listAgents = async (req, res) => {
  try {
    const agents = await getAgents();
    res.json(agents);
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
