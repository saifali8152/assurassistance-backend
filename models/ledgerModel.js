// src/models/ledgerModel.js
import getPool from "../utils/db.js";


export const getLedger = async ({ role, agentId, agentIds, startDate, endDate, status, paymentStatus, search, page = 1, limit = 25 }) => {
  const pool = getPool();
  const offset = (page - 1) * limit;
  const params = [];
  let whereClauses = [];

  // If agent role, limit to their sales (and sub-agents' if main agent)
  if (role === "agent") {
    const ids = agentIds && agentIds.length > 0 ? agentIds : [agentId];
    if (ids.length === 1) {
      whereClauses.push("c.created_by = ?");
      params.push(ids[0]);
    } else {
      whereClauses.push(`c.created_by IN (${ids.map(() => "?").join(",")})`);
      params.push(...ids);
    }
  }

  if (startDate) {
    whereClauses.push("s.confirmed_at >= ?");
    params.push(startDate + " 00:00:00");
  }
  if (endDate) {
    whereClauses.push("s.confirmed_at <= ?");
    params.push(endDate + " 23:59:59");
  }
  if (status) {
    whereClauses.push("c.status = ?");
    params.push(status);
  }
  if (paymentStatus) {
    whereClauses.push("s.payment_status = ?");
    params.push(paymentStatus);
  }
  if (search) {
    whereClauses.push("(CONCAT(t.first_name, ' ', t.last_name) LIKE ? OR s.policy_number LIKE ? OR s.certificate_number LIKE ? OR cat.name LIKE ?)");
    const sterm = `%${search}%`;
    params.push(sterm, sterm, sterm, sterm);
  }

  const whereSQL = whereClauses.length ? "WHERE " + whereClauses.join(" AND ") : "";

  const baseSQL = `
    FROM sales s
    JOIN cases c ON s.case_id = c.id
    JOIN travellers t ON c.traveller_id = t.id
    LEFT JOIN catalogue cat ON c.selected_plan_id = cat.id
    LEFT JOIN users u ON c.created_by = u.id
    ${whereSQL}
  `;

  // total count
  const [countRows] = await pool.query(`SELECT COUNT(*) as total ${baseSQL}`, params);
  const total = countRows[0].total;

  // fetch page
  const dataSQL = `
    SELECT 
      s.id as sale_id, 
      s.case_id, 
      c.created_by as agent_id, 
      u.name as created_by_name,
      CONCAT(t.first_name, ' ', t.last_name) as traveller_name, 
      t.phone as traveller_phone,
      cat.name as plan_name, 
      cat.product_type,
      s.policy_number, 
      s.certificate_number,
      s.plan_price,
      s.premium_amount, 
      s.tax, 
      s.total,
      COALESCE(s.received_amount, 0) as received_amount,
      COALESCE(s.payment_notes, '') as payment_notes,
      s.payment_status, 
      s.confirmed_at
    ${baseSQL}
    ORDER BY s.confirmed_at DESC
    LIMIT ? OFFSET ?
  `;
  const dataParams = [...params, Number(limit), Number(offset)];
  const [rows] = await pool.query(dataSQL, dataParams);

  return { rows, total, page: Number(page), limit: Number(limit) };
};
