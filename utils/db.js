import mysql from 'mysql2';

let pool = null;

// Initialize the database pool
export const initializePool = (config) => {
  if (!pool) {
    pool = mysql.createPool({
      host: config.DB_HOST,
      port: Number(config.DB_PORT || 3306),
      user: config.DB_USER,
      password: config.DB_PASSWORD,
      database: config.DB_NAME,
      waitForConnections: true,
      connectionLimit: 10,
      queueLimit: 0
    }).promise();
  }
  return pool;
};

// Get the pool instance
export const getPool = () => {
  if (!pool) {
    throw new Error('Database pool not initialized. Make sure to call initializePool() first.');
  }
  return pool;
};

// Export the pool getter as default
export default getPool;
