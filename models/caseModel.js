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

// append to src/models/caseModel.js

export const getCaseDetailsById = async (caseId) => {
  const pool = getPool();
  const [rows] = await pool.query(
    `SELECT c.*, t.first_name, t.last_name, t.date_of_birth, t.country_of_residence, t.gender, t.nationality, CONCAT(t.first_name, ' ', t.last_name) as full_name, t.phone, t.email, t.passport_or_id, t.address, cat.id AS plan_id, cat.name AS plan_name, cat.product_type, cat.coverage, cat.flat_price, cat.pricing_rules, cat.currency, cat.partner_insurer_logo AS plan_partner_insurer_logo, c.duration_days
     FROM cases c
     JOIN travellers t ON c.traveller_id = t.id
     LEFT JOIN catalogue cat ON c.selected_plan_id = cat.id
     WHERE c.id = ? LIMIT 1`,
    [caseId]
  );
  return rows[0];
};

// Get all cases with pagination (for admin)
export const getAllCasesWithPagination = async (page = 1, limit = 10) => {
  const pool = getPool();
  const offset = (page - 1) * limit;
  
  // Get total count
  const [countResult] = await pool.query('SELECT COUNT(*) as total FROM cases');
  const totalCases = countResult[0].total;
  
  // Get cases with pagination
  const [rows] = await pool.query(
    `SELECT c.*, t.first_name, t.last_name, t.date_of_birth, t.country_of_residence, t.gender, t.nationality, t.phone, t.email, t.address, t.passport_or_id, CONCAT(t.first_name, ' ', t.last_name) as full_name, cat.name as plan_name, cat.product_type, cat.coverage, cat.flat_price, cat.pricing_rules, cat.currency, cat.country_of_residence as plan_country_of_residence, cat.route_type, s.id as sale_id, u.name as created_by_name, c.duration_days
     FROM cases c
     JOIN travellers t ON c.traveller_id = t.id
     JOIN catalogue cat ON c.selected_plan_id = cat.id
     LEFT JOIN sales s ON c.id = s.case_id
     LEFT JOIN users u ON c.created_by = u.id
     ORDER BY c.created_at DESC
     LIMIT ? OFFSET ?`,
    [limit, offset]
  );
  
  return {
    cases: rows,
    totalCases,
    totalPages: Math.ceil(totalCases / limit),
    currentPage: page
  };
};

// Get cases by agent with pagination (single id - backward compatible)
export const getCasesByAgentWithPagination = async (agentId, page = 1, limit = 10) => {
  return getCasesByAgentIdsWithPagination([agentId], page, limit);
};

// Get cases by agent ids with pagination (self + sub-agents)
export const getCasesByAgentIdsWithPagination = async (agentIds, page = 1, limit = 10) => {
  if (!agentIds || agentIds.length === 0) {
    return { cases: [], totalCases: 0, totalPages: 0, currentPage: page };
  }
  const pool = getPool();
  const offset = (page - 1) * limit;
  const placeholders = agentIds.map(() => '?').join(',');
  
  const [countResult] = await pool.query(
    `SELECT COUNT(*) as total FROM cases WHERE created_by IN (${placeholders})`,
    agentIds
  );
  const totalCases = countResult[0].total;
  
  const [rows] = await pool.query(
    `SELECT c.*, t.first_name, t.last_name, t.date_of_birth, t.country_of_residence, t.gender, t.nationality, t.phone, t.email, t.address, t.passport_or_id, CONCAT(t.first_name, ' ', t.last_name) as full_name, cat.name as plan_name, cat.product_type, cat.coverage, cat.flat_price, cat.pricing_rules, cat.currency, cat.country_of_residence as plan_country_of_residence, cat.route_type, s.id as sale_id, c.duration_days
     FROM cases c
     JOIN travellers t ON c.traveller_id = t.id
     JOIN catalogue cat ON c.selected_plan_id = cat.id
     LEFT JOIN sales s ON c.id = s.case_id
     WHERE c.created_by IN (${placeholders})
     ORDER BY c.created_at DESC
     LIMIT ? OFFSET ?`,
    [...agentIds, limit, offset]
  );
  
  return {
    cases: rows,
    totalCases,
    totalPages: Math.ceil(totalCases / limit),
    currentPage: page
  };
};

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

