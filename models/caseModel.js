//src/models/caseModel.js

import getPool from "../utils/db.js";
import { normalizeDateOfBirthForDb } from "../utils/parseFlexibleDate.js";
import { coerceGenderForDb } from "../utils/normalizeGender.js";

// Create Traveller
export const createTraveller = async (data) => {
  const pool = getPool();
  const { first_name, last_name, date_of_birth, country_of_residence, gender, nationality, passport_or_id, phone, email, address } = data;
  
  const rawDob = date_of_birth != null ? String(date_of_birth).trim() : "";
  const dateOfBirth = rawDob ? normalizeDateOfBirthForDb(date_of_birth) : null;
  const countryOfResidence = (country_of_residence && country_of_residence.trim() !== '') ? country_of_residence.trim() : null;
  const genderValue = coerceGenderForDb(gender);
  const nationalityValue = (nationality && nationality.trim() !== '') ? nationality.trim() : null;
  const passportOrId = (passport_or_id && passport_or_id.trim() !== '') ? passport_or_id.trim() : null;
  const phoneValue = (phone && phone.trim() !== '') ? phone.trim() : null;
  const emailValue = (email && email.trim() !== '') ? email.trim() : null;
  const addressValue = (address && address.trim() !== '') ? address.trim() : null;
  
  const [result] = await pool.execute(
    `INSERT INTO travellers (first_name, last_name, date_of_birth, country_of_residence, gender, nationality, passport_or_id, phone, email, address)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      first_name?.trim() || null,
      last_name?.trim() || null,
      dateOfBirth,
      countryOfResidence,
      genderValue,
      nationalityValue,
      passportOrId,
      phoneValue,
      emailValue,
      addressValue
    ]
  );
  return result.insertId;
};

// Create Case
export const createCase = async (data) => {
  const pool = getPool();
  const { traveller_id, destination, start_date, end_date, selected_plan_id, created_by, status, group_id = null } = data;
  // Destination can be a string (comma-separated) or array - convert to string
  const destinationStr = Array.isArray(destination) ? destination.join(", ") : destination;
  const [result] = await pool.execute(
    `INSERT INTO cases (traveller_id, destination, start_date, end_date, selected_plan_id, created_by, status, group_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [traveller_id, destinationStr, start_date, end_date, selected_plan_id, created_by, status || "Draft", group_id || null]
  );
  return result.insertId;
};

// Get Cases for an Agent (single id - backward compatible)
export const getCasesByAgent = async (agentId) => {
  return getCasesByAgentIds([agentId]);
};

// Get Cases for one or more agents (self + sub-agents for main agent)
export const getCasesByAgentIds = async (agentIds) => {
  if (!agentIds || agentIds.length === 0) return [];
  const pool = getPool();
  const placeholders = agentIds.map(() => '?').join(',');
  const [rows] = await pool.query(
    `SELECT c.*, t.first_name, t.last_name, t.date_of_birth, t.country_of_residence, t.gender, t.nationality, CONCAT(t.first_name, ' ', t.last_name) as full_name, cat.name as plan_name
     FROM cases c
     JOIN travellers t ON c.traveller_id = t.id
     JOIN catalogue cat ON c.selected_plan_id = cat.id
     WHERE c.created_by IN (${placeholders})
     ORDER BY c.created_at DESC`,
    agentIds
  );
  return rows;
};

// Get Cases without Sales (Pending Sales) - single id
export const getCasesWithoutSales = async (agentId) => {
  return getCasesWithoutSalesByAgentIds([agentId]);
};

// Get Cases without Sales by agent ids (self + sub-agents)
export const getCasesWithoutSalesByAgentIds = async (agentIds) => {
  if (!agentIds || agentIds.length === 0) return [];
  const pool = getPool();
  const placeholders = agentIds.map(() => '?').join(',');
  const [rows] = await pool.query(
    `SELECT c.*, t.first_name, t.last_name, t.date_of_birth, t.country_of_residence, t.gender, t.nationality, CONCAT(t.first_name, ' ', t.last_name) as full_name, t.phone, t.email, cat.name as plan_name, cat.product_type, cat.coverage, cat.flat_price
     FROM cases c
     JOIN travellers t ON c.traveller_id = t.id
     JOIN catalogue cat ON c.selected_plan_id = cat.id
     LEFT JOIN sales s ON c.id = s.case_id
     WHERE c.created_by IN (${placeholders}) AND c.status = 'Confirmed' AND s.id IS NULL
     ORDER BY c.created_at DESC`,
    agentIds
  );
  return rows;
};

// Update Case Status
export const updateCaseStatus = async (caseId, status) => {
  const pool = getPool();
  await pool.execute(`UPDATE cases SET status = ? WHERE id = ?`, [status, caseId]);
};

/**
 * Permanently delete a case. Sales / invoices / certificates cascade via FK.
 * Also removes the traveller when no other cases still reference them.
 */
export const deleteCaseById = async (caseId) => {
  const pool = getPool();
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [cases] = await conn.query(
      `SELECT id, traveller_id FROM cases WHERE id = ? LIMIT 1`,
      [caseId]
    );
    if (!cases.length) {
      await conn.rollback();
      return { deleted: false };
    }

    const travellerId = cases[0].traveller_id;
    await conn.query(`DELETE FROM cases WHERE id = ?`, [caseId]);

    const [remaining] = await conn.query(
      `SELECT COUNT(*) AS cnt FROM cases WHERE traveller_id = ?`,
      [travellerId]
    );
    if (Number(remaining[0]?.cnt || 0) === 0) {
      await conn.query(`DELETE FROM travellers WHERE id = ?`, [travellerId]);
    }

    await conn.commit();
    return { deleted: true, travellerId };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
};

// append to src/models/caseModel.js

export const getCaseDetailsById = async (caseId) => {
  const pool = getPool();
  const [rows] = await pool.query(
    `SELECT c.*, t.first_name, t.last_name, t.date_of_birth, t.country_of_residence, t.gender, t.nationality, CONCAT(t.first_name, ' ', t.last_name) as full_name, t.phone, t.email, t.passport_or_id, t.address, cat.id AS plan_id, cat.name AS plan_name, cat.product_type, cat.coverage, cat.flat_price, cat.pricing_rules, cat.currency, cat.partner_insurer_logo AS plan_partner_insurer_logo, cat.theme_color AS plan_theme_color, cat.extra_id_fields AS plan_extra_id_fields, cat.fixed_duration_premiums AS plan_fixed_duration_premiums, c.duration_days
     FROM cases c
     JOIN travellers t ON c.traveller_id = t.id
     LEFT JOIN catalogue cat ON c.selected_plan_id = cat.id
     WHERE c.id = ? LIMIT 1`,
    [caseId]
  );
  return rows[0];
};

const CASE_LIST_FROM = `
  FROM cases c
  JOIN travellers t ON c.traveller_id = t.id
  JOIN catalogue cat ON c.selected_plan_id = cat.id
  LEFT JOIN sales s ON c.id = s.case_id
  LEFT JOIN users u ON c.created_by = u.id
`;

const CASE_LIST_SELECT = `
  SELECT c.*, t.first_name, t.last_name, t.date_of_birth, t.country_of_residence, t.gender, t.nationality,
         t.phone, t.email, t.address, t.passport_or_id,
         CONCAT(t.first_name, ' ', t.last_name) AS full_name,
         cat.name AS plan_name, cat.product_type, cat.coverage, cat.flat_price, cat.pricing_rules,
         cat.currency, cat.country_of_residence AS plan_country_of_residence, cat.route_type,
         cat.fixed_duration_premiums,
         s.id AS sale_id, s.plan_price AS sale_plan_price, s.premium_amount AS sale_premium_amount,
         u.name AS created_by_name, c.duration_days
`;

/** Shared WHERE builder for paginated case listings (admin, sub-admin scope, agents). */
function buildCaseListFilters({ agentIds, status, startDate, endDate, search }) {
  const params = [];
  const whereClauses = [];

  if (agentIds && agentIds.length > 0) {
    whereClauses.push(`c.created_by IN (${agentIds.map(() => "?").join(",")})`);
    params.push(...agentIds);
  }
  if (status && String(status).trim()) {
    whereClauses.push("c.status = ?");
    params.push(String(status).trim());
  }
  if (startDate) {
    whereClauses.push("c.created_at >= ?");
    params.push(startDate + " 00:00:00");
  }
  if (endDate) {
    whereClauses.push("c.created_at <= ?");
    params.push(endDate + " 23:59:59");
  }
  if (search && String(search).trim()) {
    const term = `%${String(search).trim()}%`;
    whereClauses.push(`(
      CONCAT(t.first_name, ' ', t.last_name) LIKE ?
      OR t.email LIKE ?
      OR t.phone LIKE ?
      OR c.destination LIKE ?
      OR cat.name LIKE ?
      OR CAST(c.id AS CHAR) LIKE ?
      OR u.name LIKE ?
      OR s.policy_number LIKE ?
      OR s.certificate_number LIKE ?
    )`);
    params.push(term, term, term, term, term, term, term, term, term);
  }

  const whereSQL = whereClauses.length ? "WHERE " + whereClauses.join(" AND ") : "";
  return { whereSQL, params };
}

async function queryCasesPaginated({ agentIds, page, limit, status, startDate, endDate, search }) {
  const pool = getPool();
  const pageNum = Math.max(1, Number(page) || 1);
  const limitNum = Math.min(200, Math.max(1, Number(limit) || 25));
  const offset = (pageNum - 1) * limitNum;

  if (agentIds && agentIds.length === 0) {
    return { cases: [], totalCases: 0, totalPages: 0, currentPage: pageNum, limit: limitNum };
  }

  const { whereSQL, params } = buildCaseListFilters({
    agentIds,
    status,
    startDate,
    endDate,
    search
  });

  const [countRows] = await pool.query(
    `SELECT COUNT(*) AS total ${CASE_LIST_FROM} ${whereSQL}`,
    params
  );
  const totalCases = Number(countRows[0]?.total) || 0;

  const [rows] = await pool.query(
    `${CASE_LIST_SELECT} ${CASE_LIST_FROM} ${whereSQL}
     ORDER BY c.created_at DESC
     LIMIT ? OFFSET ?`,
    [...params, limitNum, offset]
  );

  return {
    cases: rows,
    totalCases,
    totalPages: Math.max(1, Math.ceil(totalCases / limitNum) || 1),
    currentPage: pageNum,
    limit: limitNum
  };
}

// Get all cases with pagination + filters (admin: no agent scope)
export const getAllCasesWithPagination = async ({
  page = 1,
  limit = 25,
  search,
  status,
  startDate,
  endDate
} = {}) => {
  return queryCasesPaginated({ page, limit, search, status, startDate, endDate });
};

// Get cases by agent with pagination (single id)
export const getCasesByAgentWithPagination = async (agentId, opts = {}) =>
  getCasesByAgentIdsWithPagination([agentId], opts);

// Get cases by agent ids with pagination (self + sub-agents / sub-admin scope)
export const getCasesByAgentIdsWithPagination = async (agentIds, opts = {}) =>
  queryCasesPaginated({ agentIds, ...opts });

// Update case and traveller
export const updateCaseAndTraveller = async (caseId, travellerData, caseData) => {
  const pool = getPool();
  const connection = await pool.getConnection();
  
  try {
    await connection.beginTransaction();
    
    // Get the traveller_id from the case
    const [caseResult] = await connection.query(
      'SELECT traveller_id FROM cases WHERE id = ?',
      [caseId]
    );
    
    if (caseResult.length === 0) {
      throw new Error('Case not found');
    }
    
    const travellerId = caseResult[0].traveller_id;
    
    // Update traveller - ensure all optional fields are null instead of undefined
    const rawDobUpd = travellerData.date_of_birth != null ? String(travellerData.date_of_birth).trim() : "";
    const dateOfBirth = rawDobUpd ? normalizeDateOfBirthForDb(travellerData.date_of_birth) : null;
    const countryOfResidence = (travellerData.country_of_residence && travellerData.country_of_residence.trim() !== '') ? travellerData.country_of_residence.trim() : null;
    const genderValue = coerceGenderForDb(travellerData.gender);
    const nationalityValue = (travellerData.nationality && travellerData.nationality.trim() !== '') ? travellerData.nationality.trim() : null;
    const passportOrId = (travellerData.passport_or_id && travellerData.passport_or_id.trim() !== '') ? travellerData.passport_or_id.trim() : null;
    const phoneValue = (travellerData.phone && travellerData.phone.trim() !== '') ? travellerData.phone.trim() : null;
    const emailValue = (travellerData.email && travellerData.email.trim() !== '') ? travellerData.email.trim() : null;
    const addressValue = (travellerData.address && travellerData.address.trim() !== '') ? travellerData.address.trim() : null;
    
    await connection.execute(
      `UPDATE travellers SET 
       first_name = ?, last_name = ?, date_of_birth = ?, country_of_residence = ?, gender = ?, nationality = ?, passport_or_id = ?, phone = ?, email = ?, address = ?
       WHERE id = ?`,
      [
        travellerData.first_name?.trim() || null,
        travellerData.last_name?.trim() || null,
        dateOfBirth,
        countryOfResidence,
        genderValue,
        nationalityValue,
        passportOrId,
        phoneValue,
        emailValue,
        addressValue,
        travellerId
      ]
    );
    
    // Update case
    // Destination can be a string (comma-separated) or array - convert to string
    const destinationStr = Array.isArray(caseData.destination) ? caseData.destination.join(", ") : caseData.destination;
    await connection.execute(
      `UPDATE cases SET 
       destination = ?, start_date = ?, end_date = ?, selected_plan_id = ?
       WHERE id = ?`,
      [
        destinationStr,
        caseData.start_date,
        caseData.end_date,
        caseData.selected_plan_id,
        caseId
      ]
    );
    
    await connection.commit();
    return true;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
};

