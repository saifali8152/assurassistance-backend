// src/models/ledgerModel.js
import getPool from "../utils/db.js";
import { commissionForSale } from "../utils/commissionRules.js";

function buildLedgerWhere({ role, agentId, agentIds, startDate, endDate, status, paymentStatus, search }) {
  const params = [];
  const whereClauses = [];

  // Agents / sub-admins: visibility set (self + descendants / owned agencies).
  if (role === "agent" || role === "sub_admin") {
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
    params.push(`${startDate} 00:00:00`);
  }
  if (endDate) {
    whereClauses.push("s.confirmed_at <= ?");
    params.push(`${endDate} 23:59:59`);
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
    whereClauses.push(
      "(CONCAT(t.first_name, ' ', t.last_name) LIKE ? OR s.policy_number LIKE ? OR s.certificate_number LIKE ? OR cat.name LIKE ?)"
    );
    const sterm = `%${search}%`;
    params.push(sterm, sterm, sterm, sterm);
  }

  return {
    whereSQL: whereClauses.length ? `WHERE ${whereClauses.join(" AND ")}` : "",
    params,
  };
}

function mapLedgerRow(r) {
  const planPremium =
    r.plan_price != null && Number(r.plan_price) > 0
      ? Number(r.plan_price)
      : Number(r.premium_amount) || 0;
  const tax = Number(r.tax) || 0;
  const commission = commissionForSale({
    premium: planPremium,
    durationDays: r.duration_days,
    dateOfBirth: r.date_of_birth,
    fixedDurationPremiums: !!Number(r.fixed_duration_premiums),
  });
  return {
    sale_id: r.sale_id,
    case_id: r.case_id,
    agent_id: r.agent_id,
    created_by_name: r.created_by_name || "",
    traveller_name: r.traveller_name,
    traveller_phone: r.traveller_phone || "",
    plan_name: r.plan_name || "",
    product_type: r.product_type || "",
    policy_number: r.policy_number || "",
    certificate_number: r.certificate_number || "",
    plan_price: r.plan_price != null ? Number(r.plan_price) : null,
    premium_amount: Number(r.premium_amount) || 0,
    plan_premium: planPremium,
    tax,
    total: planPremium + tax,
    received_amount: Number(r.received_amount) || 0,
    payment_notes: r.payment_notes || "",
    payment_status: r.payment_status,
    confirmed_at: r.confirmed_at,
    currency: r.currency || "XOF",
    commission,
    net_to_transfer: planPremium + tax - commission,
  };
}

export const getLedger = async ({
  role,
  agentId,
  agentIds,
  startDate,
  endDate,
  status,
  paymentStatus,
  search,
  page = 1,
  limit = 25,
}) => {
  const pool = getPool();
  const offset = (page - 1) * limit;
  const { whereSQL, params } = buildLedgerWhere({
    role,
    agentId,
    agentIds,
    startDate,
    endDate,
    status,
    paymentStatus,
    search,
  });

  const baseSQL = `
    FROM sales s
    JOIN cases c ON s.case_id = c.id
    JOIN travellers t ON c.traveller_id = t.id
    LEFT JOIN catalogue cat ON c.selected_plan_id = cat.id
    LEFT JOIN users u ON c.created_by = u.id
    ${whereSQL}
  `;

  const [countRows] = await pool.query(`SELECT COUNT(*) as total ${baseSQL}`, params);
  const total = countRows[0].total;

  const dataSQL = `
    SELECT
      s.id AS sale_id,
      s.case_id,
      c.created_by AS agent_id,
      u.name AS created_by_name,
      CONCAT(t.first_name, ' ', t.last_name) AS traveller_name,
      t.phone AS traveller_phone,
      t.date_of_birth,
      cat.name AS plan_name,
      cat.product_type,
      cat.fixed_duration_premiums,
      s.policy_number,
      s.certificate_number,
      s.plan_price,
      s.premium_amount,
      s.tax,
      s.total,
      COALESCE(s.received_amount, 0) AS received_amount,
      COALESCE(s.payment_notes, '') AS payment_notes,
      s.payment_status,
      s.confirmed_at,
      s.currency,
      c.duration_days
    ${baseSQL}
    ORDER BY s.confirmed_at DESC
    LIMIT ? OFFSET ?
  `;
  const [rows] = await pool.query(dataSQL, [...params, Number(limit), Number(offset)]);

  return {
    rows: rows.map(mapLedgerRow),
    total,
    page: Number(page),
    limit: Number(limit),
  };
};

/**
 * Period / filter totals matching partner-invoice math:
 * total policies, total commissions, net amount to transfer (premiums − commissions).
 */
export const getLedgerSummary = async ({
  role,
  agentId,
  agentIds,
  startDate,
  endDate,
  status,
  paymentStatus,
  search,
}) => {
  const pool = getPool();
  const { whereSQL, params } = buildLedgerWhere({
    role,
    agentId,
    agentIds,
    startDate,
    endDate,
    status,
    paymentStatus,
    search,
  });

  const [rows] = await pool.query(
    `SELECT
       CASE WHEN s.plan_price IS NOT NULL AND s.plan_price > 0
            THEN s.plan_price ELSE s.premium_amount END AS plan_premium,
       COALESCE(s.tax, 0) AS tax,
       COALESCE(s.received_amount, 0) AS received_amount,
       c.duration_days,
       t.date_of_birth,
       cat.fixed_duration_premiums
     FROM sales s
     JOIN cases c ON s.case_id = c.id
     JOIN travellers t ON c.traveller_id = t.id
     LEFT JOIN catalogue cat ON c.selected_plan_id = cat.id
     LEFT JOIN users u ON c.created_by = u.id
     ${whereSQL}`,
    params
  );

  const acc = {
    totalPolicies: rows.length,
    totalPremiums: 0,
    totalCollected: 0,
    totalCommissions: 0,
  };
  for (const r of rows) {
    const premium = Number(r.plan_premium) || 0;
    const tax = Number(r.tax) || 0;
    acc.totalPremiums += premium + tax;
    acc.totalCollected += Number(r.received_amount) || 0;
    acc.totalCommissions += commissionForSale({
      premium,
      durationDays: r.duration_days,
      dateOfBirth: r.date_of_birth,
      fixedDurationPremiums: !!Number(r.fixed_duration_premiums),
    });
  }
  const round2 = (n) => Math.round(Number(n) * 100) / 100;
  return {
    totalPolicies: acc.totalPolicies,
    totalPremiums: round2(acc.totalPremiums),
    totalCollected: round2(acc.totalCollected),
    totalCommissions: round2(acc.totalCommissions),
    netToTransfer: round2(acc.totalPremiums - acc.totalCommissions),
  };
};
