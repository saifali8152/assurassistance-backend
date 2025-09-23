//src/models/caseModel.js

import pool from "../db.js";

// Create Traveller
export const createTraveller = async (data) => {
  const { full_name, passport_or_id, phone, email, address } = data;
  const [result] = await pool.execute(
    `INSERT INTO travellers (full_name, passport_or_id, phone, email, address)
     VALUES (?, ?, ?, ?, ?)`,
    [full_name, passport_or_id, phone, email, address]
  );
  return result.insertId;
};

// Create Case
export const createCase = async (data) => {
  const { traveller_id, destination, start_date, end_date, selected_plan_id, created_by } = data;
  const [result] = await pool.execute(
    `INSERT INTO cases (traveller_id, destination, start_date, end_date, selected_plan_id, created_by)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [traveller_id, destination, start_date, end_date, selected_plan_id, created_by]
  );
  return result.insertId;
};

// Get Cases for an Agent
export const getCasesByAgent = async (agentId) => {
  const [rows] = await pool.query(
    `SELECT c.*, t.full_name, cat.name as plan_name
     FROM cases c
     JOIN travellers t ON c.traveller_id = t.id
     JOIN catalogue cat ON c.selected_plan_id = cat.id
     WHERE c.created_by = ?
     ORDER BY c.created_at DESC`,
    [agentId]
  );
  return rows;
};

// Update Case Status
export const updateCaseStatus = async (caseId, status) => {
  await pool.execute(`UPDATE cases SET status = ? WHERE id = ?`, [status, caseId]);
};

// append to src/models/caseModel.js

export const getCaseDetailsById = async (caseId) => {
  const [rows] = await pool.query(
    `SELECT c.*, t.full_name, t.phone, t.email, t.passport_or_id, cat.id AS plan_id, cat.name AS plan_name, cat.product_type, cat.coverage, cat.flat_price
     FROM cases c
     JOIN travellers t ON c.traveller_id = t.id
     LEFT JOIN catalogue cat ON c.selected_plan_id = cat.id
     WHERE c.id = ? LIMIT 1`,
    [caseId]
  );
  return rows[0];
};
