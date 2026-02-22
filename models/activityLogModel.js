import getPool from "../utils/db.js";

export const getActivityLog = async (params = {}) => {
  const pool = getPool();
  const {
    page = 1,
    limit = 25,
    search = "",
    startDate = "",
    endDate = "",
  } = params;

  const offset = (page - 1) * limit;
  let whereConditions = [];
  let baseQueryParams = [];

  try {
    // Base query with JOIN to get user information
    let baseSQL = `
      SELECT 
        ua.id,
        ua.user_id,
        ua.activity_type,
        ua.activity_date,
        u.name as user_name,
        u.email as user_email
      FROM user_activity ua
      LEFT JOIN users u ON ua.user_id = u.id
    `;

    // Add search condition
    if (search && search.trim()) {
      whereConditions.push(
        `(u.name LIKE ? OR u.email LIKE ? OR ua.activity_type LIKE ?)`
      );
      const searchParam = `%${search.trim()}%`;
      baseQueryParams.push(searchParam, searchParam, searchParam);
    }


    // Add date range filters
    if (startDate && startDate.trim()) {
      whereConditions.push(`DATE(ua.activity_date) >= ?`);
      baseQueryParams.push(startDate.trim());
    }

    if (endDate && endDate.trim()) {
      whereConditions.push(`DATE(ua.activity_date) <= ?`);
      baseQueryParams.push(endDate.trim());
    }

    // Build the complete query
    if (whereConditions.length > 0) {
      baseSQL += ` WHERE ${whereConditions.join(" AND ")}`;
    }

    // Add ordering and pagination
    // Use string interpolation for LIMIT and OFFSET to avoid parameter issues
    const validLimit = parseInt(limit) || 25;
    const validOffset = parseInt(offset) || 0;
    
    baseSQL += ` ORDER BY ua.activity_date DESC LIMIT ${validLimit} OFFSET ${validOffset}`;
    
    // Create parameters for main query (only base params, no limit/offset)
    const mainQueryParams = [...baseQueryParams];

    // Execute the main query
    const [activities] = await pool.execute(baseSQL, mainQueryParams);

    // Get total count for pagination
    let countSQL = `
      SELECT COUNT(*) as total
      FROM user_activity ua
      LEFT JOIN users u ON ua.user_id = u.id
    `;

    if (whereConditions.length > 0) {
      countSQL += ` WHERE ${whereConditions.join(" AND ")}`;
    }

    // Use base query parameters for count (without limit and offset)
    const [[{ total }]] = await pool.execute(countSQL, baseQueryParams);

    return {
      data: activities,
      meta: {
        total,
        page: parseInt(page),
        limit: parseInt(limit),
        totalPages: Math.ceil(total / limit),
      },
    };
  } catch (error) {
    console.error('Error in getActivityLog:', error);
    throw error;
  }
};

export const deleteActivity = async (activityId) => {
  const pool = getPool();
  const [result] = await pool.execute(
    `DELETE FROM user_activity WHERE id = ?`,
    [activityId]
  );
  return result.affectedRows > 0;
};

export const deleteAllActivities = async () => {
  const pool = getPool();
  const [result] = await pool.execute(`TRUNCATE TABLE user_activity`);
  return result.affectedRows;
};
