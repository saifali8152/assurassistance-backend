import getPool from "../utils/db.js";

export const logActivity = async (userId, activityType) => {
  const pool = getPool();
  await pool.execute(
    `INSERT INTO user_activity (user_id, activity_type) VALUES (?, ?)`,
    [userId, activityType]
  );
};
