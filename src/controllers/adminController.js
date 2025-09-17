// src/controllers/adminController.js
import bcrypt from 'bcryptjs';
import { createUser, findUserByEmail, getAllUsers } from '../models/userModel.js';
import crypto from 'crypto';

export const createAgent = async (req, res) => {
  try {
    const { name, email, tempPassword } = req.body;
    if (!name || !email) return res.status(400).json({ message: 'Name and email are required' });

    const exists = await findUserByEmail(email);
    if (exists) return res.status(400).json({ message: 'User with this email already exists' });

    const password = tempPassword || crypto.randomBytes(4).toString('hex');
    const hashed = await bcrypt.hash(password, 10);

    // role_id for Agent is 2 (from our roles table)
    const userId = await createUser({ name, email, password: hashed, role_id: 2, force_password_change: 1 });

    res.status(201).json({ id: userId, email, tempPassword: password, message: 'Agent created. Share the tempPassword with agent' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error' });
  }
};


export const listAgents = async (req, res) => {
  try {
    const users = await getAllUsers();
    res.json(users);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error' });
  }
};
