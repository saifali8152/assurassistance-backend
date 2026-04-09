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

export const createUser = async ({
  name, email, password, role, force_password_change = 0,
  company_name = null, partnership_type = null, country_of_residence = null,
  iata_number = null, geographical_location = null, work_phone = null, whatsapp_phone = null,
  parent_agent_id = null
}) => {
  const pool = getPool();
  const [result] = await pool.execute(
    `INSERT INTO users (name, email, password, role, force_password_change,
      company_name, partnership_type, country_of_residence, iata_number,
      geographical_location, work_phone, whatsapp_phone, parent_agent_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      name, email, password, role, force_password_change ? 1 : 0,
      company_name || null, partnership_type || null, country_of_residence || null,
      iata_number || null, geographical_location || null, work_phone || null, whatsapp_phone || null,
      parent_agent_id || null
    ]
  );
  return result.insertId;
};

export const updateAgentProfile = async (userId, {
  name, company_name, partnership_type, country_of_residence, iata_number,
  geographical_location, work_phone, whatsapp_phone
}) => {
  const pool = getPool();
  const updates = [];
  const values = [];
  if (name !== undefined) { updates.push('name = ?'); values.push(name); }
  if (company_name !== undefined) { updates.push('company_name = ?'); values.push(company_name || null); }
  if (partnership_type !== undefined) { updates.push('partnership_type = ?'); values.push(partnership_type || null); }
  if (country_of_residence !== undefined) { updates.push('country_of_residence = ?'); values.push(country_of_residence || null); }
  if (iata_number !== undefined) { updates.push('iata_number = ?'); values.push(iata_number || null); }
  if (geographical_location !== undefined) { updates.push('geographical_location = ?'); values.push(geographical_location || null); }
  if (work_phone !== undefined) { updates.push('work_phone = ?'); values.push(work_phone || null); }
  if (whatsapp_phone !== undefined) { updates.push('whatsapp_phone = ?'); values.push(whatsapp_phone || null); }
  if (updates.length === 0) return 0;
  values.push(userId);
  const [result] = await pool.execute(
    `UPDATE users SET ${updates.join(', ')} WHERE id = ?`,
    values
  );
  return result.affectedRows;
};

export const getAgentAssignedPlanIds = async (userId) => {
  const pool = getPool();
  const [rows] = await pool.query('SELECT catalogue_id FROM user_assigned_plans WHERE user_id = ?', [userId]);
  return rows.map((r) => r.catalogue_id);
};

export const setAgentAssignedPlans = async (userId, catalogueIds) => {
  const pool = getPool();
  await pool.execute('DELETE FROM user_assigned_plans WHERE user_id = ?', [userId]);
  if (catalogueIds && catalogueIds.length > 0) {
    const placeholders = catalogueIds.map(() => '(?, ?)').join(', ');
    const values = catalogueIds.flatMap((id) => [userId, id]);
    await pool.execute(
      `INSERT INTO user_assigned_plans (user_id, catalogue_id) VALUES ${placeholders}`,
      values
    );
  }
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
     WHERE u.role = 'agent'`
  );
  return rows;
};

/** Direct children (agents under supervisor, or sub-agents under agent) */
export const getSubAgentIds = async (parentId) => {
  const pool = getPool();
  const [rows] = await pool.query(
    'SELECT id FROM users WHERE role = ? AND parent_agent_id = ?',
    ['agent', parentId]
  );
  return rows.map((r) => r.id);
};

/** All descendant ids for a supervisor (agents + their sub-agents). Supervisor → Agent → Sub-agent. */
export const getAllDescendantIds = async (supervisorId) => {
  const agentIds = await getSubAgentIds(supervisorId);
  const subAgentIds = [];
  for (const aid of agentIds) {
    subAgentIds.push(...(await getSubAgentIds(aid)));
  }
  return [...agentIds, ...subAgentIds];
};

/** Visibility: supervisor sees self + all agents + sub-agents; agent sees self + sub-agents; sub-agent sees only self */
export const getAgentVisibilityIds = async (userId) => {
  const user = await findUserById(userId);
  if (!user || user.role_name !== 'agent') return [userId];
  if (user.parent_agent_id == null) {
    const descendantIds = await getAllDescendantIds(userId);
    return [userId, ...descendantIds];
  }
  const parent = await findUserById(user.parent_agent_id);
  if (parent && parent.parent_agent_id == null) {
    return [userId, ...(await getSubAgentIds(userId))];
  }
  return [userId];
};

/** Sub-agents under an agent (for admin list) */
export const getSubAgents = async (agentId) => {
  const pool = getPool();
  const [rows] = await pool.query(
    `SELECT u.id, u.name, u.email, u.status, u.work_phone, u.whatsapp_phone, u.created_at,
            (SELECT GROUP_CONCAT(catalogue_id) FROM user_assigned_plans WHERE user_id = u.id) AS assigned_plan_ids
     FROM users u
     WHERE u.role = 'agent' AND u.parent_agent_id = ?
     ORDER BY u.created_at DESC`,
    [agentId]
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

/**
 * Ordered user IDs to delete: sub-agents first, then agents, then root (supervisor or single agent).
 */
export const getAgentDeletionOrder = async (rootUserId) => {
  const user = await findUserById(rootUserId);
  if (!user || user.role_name !== 'agent') {
    return { error: 'NOT_AGENT', order: [] };
  }
  const id = parseInt(String(rootUserId), 10);
  if (user.parent_agent_id == null || user.parent_agent_id === 0) {
    const agentIds = await getSubAgentIds(id);
    const allSubIds = [];
    for (const aid of agentIds) {
      allSubIds.push(...(await getSubAgentIds(aid)));
    }
    return { error: null, order: [...allSubIds, ...agentIds, id] };
  }
  const parent = await findUserById(user.parent_agent_id);
  if (parent && (parent.parent_agent_id == null || parent.parent_agent_id === 0)) {
    const subIds = await getSubAgentIds(id);
    return { error: null, order: [...subIds, id] };
  }
  return { error: null, order: [id] };
};

/**
 * Deletes agent user(s): supervisor removes whole tree; agent removes self + sub-agents; sub-agent removes self.
 * Deletes cases by those users (cascades sales/invoices/certificates) and travellers no longer referenced.
 */
/** Flat union: one row per supervisor, per agent under a supervisor, and per sub-agent (with context columns). */
const AGENT_HIERARCHY_UNION_SQL = `
  SELECT
    'supervisor' AS hierarchy_role,
    u.id, u.name, u.email, u.status, u.force_password_change, u.last_login, u.created_at,
    u.company_name, u.partnership_type, u.country_of_residence, u.iata_number,
    u.geographical_location, u.work_phone, u.whatsapp_phone,
    (SELECT GROUP_CONCAT(catalogue_id) FROM user_assigned_plans WHERE user_id = u.id) AS assigned_plan_ids,
    u.id AS supervisor_id, u.name AS supervisor_name, u.email AS supervisor_email,
    u.company_name AS supervisor_company_name, u.partnership_type AS supervisor_partnership_type,
    u.country_of_residence AS supervisor_country, u.iata_number AS supervisor_iata,
    u.geographical_location AS supervisor_geo, u.work_phone AS supervisor_work_phone, u.whatsapp_phone AS supervisor_whatsapp,
    NULL AS agent_id, NULL AS agent_name, NULL AS agent_email,
    NULL AS agent_company_name, NULL AS agent_partnership_type, NULL AS agent_country, NULL AS agent_iata,
    NULL AS agent_geo, NULL AS agent_work_phone, NULL AS agent_whatsapp
  FROM users u
  WHERE u.role = 'agent' AND (u.parent_agent_id IS NULL OR u.parent_agent_id = 0)
  UNION ALL
  SELECT
    'agent' AS hierarchy_role,
    a.id, a.name, a.email, a.status, a.force_password_change, a.last_login, a.created_at,
    a.company_name, a.partnership_type, a.country_of_residence, a.iata_number,
    a.geographical_location, a.work_phone, a.whatsapp_phone,
    (SELECT GROUP_CONCAT(catalogue_id) FROM user_assigned_plans WHERE user_id = a.id),
    sup.id, sup.name, sup.email,
    sup.company_name, sup.partnership_type, sup.country_of_residence, sup.iata_number,
    sup.geographical_location, sup.work_phone, sup.whatsapp_phone,
    a.id, a.name, a.email,
    a.company_name, a.partnership_type, a.country_of_residence, a.iata_number,
    a.geographical_location, a.work_phone, a.whatsapp_phone
  FROM users a
  INNER JOIN users sup ON a.parent_agent_id = sup.id
  WHERE a.role = 'agent' AND (sup.parent_agent_id IS NULL OR sup.parent_agent_id = 0)
  UNION ALL
  SELECT
    'sub_agent' AS hierarchy_role,
    sub.id, sub.name, sub.email, sub.status, sub.force_password_change, sub.last_login, sub.created_at,
    sub.company_name, sub.partnership_type, sub.country_of_residence, sub.iata_number,
    sub.geographical_location, sub.work_phone, sub.whatsapp_phone,
    (SELECT GROUP_CONCAT(catalogue_id) FROM user_assigned_plans WHERE user_id = sub.id),
    sup.id, sup.name, sup.email,
    sup.company_name, sup.partnership_type, sup.country_of_residence, sup.iata_number,
    sup.geographical_location, sup.work_phone, sup.whatsapp_phone,
    ag.id, ag.name, ag.email,
    ag.company_name, ag.partnership_type, ag.country_of_residence, ag.iata_number,
    ag.geographical_location, ag.work_phone, ag.whatsapp_phone
  FROM users sub
  INNER JOIN users ag ON sub.parent_agent_id = ag.id
  INNER JOIN users sup ON ag.parent_agent_id = sup.id
  WHERE sub.role = 'agent' AND (sup.parent_agent_id IS NULL OR sup.parent_agent_id = 0)
`;

function buildAgentHierarchyWhere(search, status) {
  const clauses = [];
  const params = [];
  if (search && String(search).trim()) {
    const t = `%${String(search).trim()}%`;
    clauses.push(
      `(flat.name LIKE ? OR flat.email LIKE ? OR flat.supervisor_name LIKE ? OR flat.supervisor_email LIKE ? OR flat.agent_name LIKE ? OR flat.agent_email LIKE ?)`
    );
    params.push(t, t, t, t, t, t);
  }
  if (status && String(status).trim()) {
    clauses.push("flat.status = ?");
    params.push(String(status).trim());
  }
  const whereSql = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  return { whereSql, params };
}

const AGENT_HIERARCHY_ORDER_SQL = `
  ORDER BY flat.supervisor_id ASC,
    CASE flat.hierarchy_role WHEN 'supervisor' THEN 0 WHEN 'agent' THEN 1 ELSE 2 END ASC,
    COALESCE(flat.agent_id, 0) ASC,
    flat.id ASC
`;

/**
 * Paginated flat hierarchy (supervisors, their agents, sub-agents) for admin.
 * @param {{ page?: number, limit?: number, search?: string, status?: string }} opts
 */
export const queryAgentHierarchyPaginated = async (opts = {}) => {
  const page = Math.max(1, parseInt(String(opts.page || 1), 10) || 1);
  const rawLimit = parseInt(String(opts.limit || 25), 10);
  const limit = Math.min(100, Math.max(1, Number.isNaN(rawLimit) ? 25 : rawLimit));
  const offset = (page - 1) * limit;
  const search = opts.search || "";
  const status = opts.status || "";

  const pool = getPool();
  const { whereSql, params } = buildAgentHierarchyWhere(search, status);
  const wrapped = `SELECT * FROM (${AGENT_HIERARCHY_UNION_SQL}) AS flat ${whereSql}`;

  const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total FROM (${AGENT_HIERARCHY_UNION_SQL}) AS flat ${whereSql}`, params);

  const [rows] = await pool.query(`${wrapped} ${AGENT_HIERARCHY_ORDER_SQL} LIMIT ? OFFSET ?`, [...params, limit, offset]);

  return {
    rows,
    total: Number(total) || 0,
    page,
    limit,
    totalPages: Math.ceil((Number(total) || 0) / limit) || 1
  };
};

/**
 * Full hierarchy for CSV export (server-side, no pagination).
 * @param {{ search?: string, status?: string }} opts
 */
export const queryAgentHierarchyAll = async (opts = {}) => {
  const search = opts.search || "";
  const status = opts.status || "";
  const pool = getPool();
  const { whereSql, params } = buildAgentHierarchyWhere(search, status);
  const wrapped = `SELECT * FROM (${AGENT_HIERARCHY_UNION_SQL}) AS flat ${whereSql}`;
  const [rows] = await pool.query(`${wrapped} ${AGENT_HIERARCHY_ORDER_SQL}`, params);
  return rows;
};

export const deleteAgentHierarchy = async (rootUserId) => {
  const pool = getPool();
  const { error, order } = await getAgentDeletionOrder(rootUserId);
  if (error) return { ok: false, message: 'User is not an agent account' };
  if (order.length === 0) return { ok: false, message: 'Nothing to delete' };

  const uniqueIds = [...new Set(order)];
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const placeholders = uniqueIds.map(() => '?').join(',');
    const [caseRows] = await conn.query(
      `SELECT DISTINCT traveller_id FROM cases WHERE created_by IN (${placeholders})`,
      uniqueIds
    );
    const travellerIds = caseRows.map((r) => r.traveller_id).filter((tid) => tid != null);

    await conn.query(`DELETE FROM cases WHERE created_by IN (${placeholders})`, uniqueIds);

    if (travellerIds.length > 0) {
      const tPlaceholders = travellerIds.map(() => '?').join(',');
      await conn.query(
        `DELETE FROM travellers WHERE id IN (${tPlaceholders})
         AND NOT EXISTS (SELECT 1 FROM cases c WHERE c.traveller_id = travellers.id)`,
        travellerIds
      );
    }

    for (const uid of order) {
      await conn.execute('DELETE FROM user_assigned_plans WHERE user_id = ?', [uid]);
      await conn.execute('DELETE FROM user_activity WHERE user_id = ?', [uid]);
      await conn.execute('DELETE FROM users WHERE id = ? AND role = ?', [uid, 'agent']);
    }

    await conn.commit();
    return { ok: true, deletedCount: order.length };
  } catch (e) {
    await conn.rollback();
    console.error('deleteAgentHierarchy:', e);
    throw e;
  } finally {
    conn.release();
  }
};

