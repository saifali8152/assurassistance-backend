import pool from "../db.js";

export const findUserByEmail = async (email) => {
  const [rows] = await pool.query('SELECT * FROM users WHERE email = ?', [email]);
  return rows[0];
};

export const findUserById = async (id) => {
  const [rows] = await pool.query('SELECT * FROM users WHERE id = ?', [id]);
  return rows[0];
};

export const createUser = async ({ name, email, password, is_admin = 0, force_password_change = 0 }) => {
  const [result] = await pool.execute(
    'INSERT INTO users (name, email, password, is_admin, force_password_change) VALUES (?, ?, ?, ?, ?)',
    [name, email, password, is_admin ? 1 : 0, force_password_change ? 1 : 0]
  );
  return result.insertId;
};

export const getAllUsers = async () => {
  const [rows] = await pool.query('SELECT id, name, email, is_admin, status, force_password_change, last_login, created_at FROM users');
  return rows;
};

export const updatePassword = async (id, hashedPassword) => {
  await pool.execute('UPDATE users SET password = ?, force_password_change = 0, updated_at = NOW() WHERE id = ?', [hashedPassword, id]);
};

export const updateLastLogin = async (id) => {
  await pool.execute('UPDATE users SET last_login = NOW() WHERE id = ?', [id]);
};
