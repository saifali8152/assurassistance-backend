// src/scripts/seedAdmin.js
import dotenv from 'dotenv';
dotenv.config();

import bcrypt from 'bcryptjs';
import pool from "../db.js";

const seed = async () => {
  try {
    const adminEmail = process.env.ADMIN_EMAIL || 'admin@example.com';
    const adminPassword = process.env.ADMIN_PASSWORD || 'Admin123!';

    const [rows] = await pool.query('SELECT id FROM users WHERE email = ?', [adminEmail]);
    if (rows.length > 0) {
      console.log('Admin user already exists:', adminEmail);
      process.exit(0);
    }

    const hashed = await bcrypt.hash(adminPassword, 10);
    const [result] = await pool.execute(
      'INSERT INTO users (name, email, password, role_id, force_password_change) VALUES (?, ?, ?, ?, ?)',
      ['Admin', adminEmail, hashed, 1, 0] // 1 = Admin role_id
    );
    

    console.log('Admin created:', adminEmail, 'id:', result.insertId);
    process.exit(0);
  } catch (err) {
    console.error('Seeding failed:', err);
    process.exit(1);
  }
};

seed();
