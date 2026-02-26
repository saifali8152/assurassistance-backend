import mysql from 'mysql2';

let pool = null;

// Initialize the database pool
export const initializePool = (config) => {
  if (!pool) {
    const rawPool = mysql.createPool({
      host: config.DB_HOST,
      port: Number(config.DB_PORT || 3306),
      user: config.DB_USER,
      password: config.DB_PASSWORD,
      database: config.DB_NAME,
      waitForConnections: true,
      connectionLimit: 10,
      queueLimit: 0,
      connectTimeout: 60000, // 60s (helps slow/VPC connections)
      enableKeepAlive: true,
      keepAliveInitialDelay: 10000,
    });
    // Prevent pool errors (e.g. ETIMEDOUT) from crashing the process
    rawPool.on('error', (err) => {
      console.error('Database pool error:', err.code || err.message);
    });
    pool = rawPool.promise();
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
