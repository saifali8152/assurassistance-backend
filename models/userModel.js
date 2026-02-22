import getPool from "../utils/db.js";

export const findUserByEmail = async (email) => {
  const pool = getPool();
  const [rows] = await pool.query(
    `SELECT u.*, u.role as role_name 
     FROM users u
     WHERE u.email = ?`, 
    [email]
  );
  return rows[0];
};

export const findUserById = async (id) => {
  const pool = getPool();
  const [rows] = await pool.query(
    `SELECT u.*, u.role as role_name 
     FROM users u
     WHERE u.id = ?`, 
    [id]
  );
  return rows[0];
};

export const createUser = async ({ name, email, password, role, force_password_change = 0 }) => {
  const pool = getPool();
  const [result] = await pool.execute(
    'INSERT INTO users (name, email, password, role, force_password_change) VALUES (?, ?, ?, ?, ?)',
    [name, email, password, role, force_password_change ? 1 : 0]
  );
  return result.insertId;
};

export const getAllUsers = async () => {
  const pool = getPool();
  const [rows] = await pool.query(
    `SELECT u.id, u.name, u.email, u.role as role_name, u.status, u.force_password_change, u.last_login, u.created_at
     FROM users u`
  );
  return rows;
};

export const getAgents = async () => {
  const pool = getPool();
  const [rows] = await pool.query(
    `SELECT u.id, u.name, u.email, u.role as role_name, u.status, 
            u.force_password_change, u.last_login, u.created_at
     FROM users u
     WHERE u.role = 'agent'`  // Only return agents
  );
  return rows;
};


export const updatePassword = async (id, hashedPassword) => {
  const pool = getPool();
  await pool.execute('UPDATE users SET password = ?, force_password_change = 0, updated_at = NOW() WHERE id = ?', [hashedPassword, id]);
};

export const updateLastLogin = async (id) => {
  const pool = getPool();
  await pool.execute('UPDATE users SET last_login = NOW() WHERE id = ?', [id]);
};

export const updateUserStatus = async (id, status) => {
  const pool = getPool();
  await pool.execute('UPDATE users SET status = ?, updated_at = NOW() WHERE id = ?', [status, id]);
};

