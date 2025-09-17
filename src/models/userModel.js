import pool from "../db.js";

export const findUserByEmail = async (email) => {
  const [rows] = await pool.query(
    `SELECT u.*, r.name as role_name 
     FROM users u
     JOIN roles r ON u.role_id = r.id
     WHERE u.email = ?`, 
    [email]
  );
  return rows[0];
};

export const findUserById = async (id) => {
  const [rows] = await pool.query(
    `SELECT u.*, r.name as role_name 
     FROM users u
     JOIN roles r ON u.role_id = r.id
     WHERE u.id = ?`, 
    [id]
  );
  return rows[0];
};

export const createUser = async ({ name, email, password, role_id, force_password_change = 0 }) => {
  const [result] = await pool.execute(
    'INSERT INTO users (name, email, password, role_id, force_password_change) VALUES (?, ?, ?, ?, ?)',
    [name, email, password, role_id, force_password_change ? 1 : 0]
  );
  return result.insertId;
};

export const getAllUsers = async () => {
  const [rows] = await pool.query(
    `SELECT u.id, u.name, u.email, r.name as role_name, u.status, u.force_password_change, u.last_login, u.created_at
     FROM users u
     JOIN roles r ON u.role_id = r.id`
  );
  return rows;
};

export const updatePassword = async (id, hashedPassword) => {
  await pool.execute('UPDATE users SET password = ?, force_password_change = 0, updated_at = NOW() WHERE id = ?', [hashedPassword, id]);
};

export const updateLastLogin = async (id) => {
  await pool.execute('UPDATE users SET last_login = NOW() WHERE id = ?', [id]);
};
