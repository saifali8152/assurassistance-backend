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

