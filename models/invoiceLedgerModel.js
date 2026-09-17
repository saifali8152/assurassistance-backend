// src/models/invoiceLedgerModel.js
//
// Paginated invoice listing with optional region grouping. Mirrors the Sales Ledger
// pattern (JOIN sales → cases → travellers → catalogue → users), but anchors on the
// `invoices` table so we surface invoice numbers and issue dates directly.
//
// "Region" is configurable:
//   - `residence`  → traveller.country_of_residence (default, insured's home country)
//   - `destination` → cases.destination (travel corridor, comma-separated TEXT)
//   - `agent`      → users.country_of_residence (selling agent's country)
//
// Visibility is enforced by the caller via `agentIds`; admins pass `agentIds = null`.
import getPool from "../utils/db.js";
import { commissionForSale } from "../utils/commissionRules.js";

const REGION_EXPRESSIONS = {
  residence: "TRIM(COALESCE(NULLIF(t.country_of_residence, ''), 'Unknown'))",
  destination: "TRIM(COALESCE(NULLIF(c.destination, ''), 'Unknown'))",
  agent: "TRIM(COALESCE(NULLIF(u.country_of_residence, ''), 'Unknown'))"
};

/** Always returns a safe region expression even if the caller passes garbage. */
function regionExpression(regionBy) {
  return REGION_EXPRESSIONS[regionBy] || REGION_EXPRESSIONS.residence;
}

/**
 * Build the shared filter chunk (WHERE clause + params). Reused by the row query,
 * count query, region summary, and CSV export so they all stay consistent.
 */
function buildFilters({
  role,
  agentId,
  agentIds,
  startDate,
  endDate,
  paymentStatus,
  region,
  search,
  partnerInsurer
}) {
  const params = [];
  const whereClauses = [];

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

  if (role === "insurer_supervisor" && partnerInsurer) {
    whereClauses.push("cat.partner_insurer = ?");
    params.push(String(partnerInsurer).trim().toLowerCase());
  }

  if (startDate) {
    whereClauses.push("i.issue_date >= ?");
    params.push(startDate + " 00:00:00");
  }
  if (endDate) {
    whereClauses.push("i.issue_date <= ?");
    params.push(endDate + " 23:59:59");
  }
  if (paymentStatus) {
    whereClauses.push("i.payment_status = ?");
    params.push(paymentStatus);
  }
  if (region && String(region).trim()) {
    // Filter via the caller-supplied region expression; we substitute placeholder
    // later so the same SQL works for residence/destination/agent.
    whereClauses.push("__REGION_EXPR__ = ?");
    params.push(String(region).trim());
  }
  if (search && String(search).trim()) {
    whereClauses.push(
      "(i.invoice_number LIKE ? OR s.policy_number LIKE ? OR s.certificate_number LIKE ? OR CONCAT(t.first_name, ' ', t.last_name) LIKE ? OR cat.name LIKE ?)"
    );
    const term = `%${String(search).trim()}%`;
    params.push(term, term, term, term, term);
  }

  return { whereClauses, params };
}

const BASE_FROM = `
  FROM invoices i
  JOIN sales s ON i.sale_id = s.id
  JOIN cases c ON s.case_id = c.id
  JOIN travellers t ON c.traveller_id = t.id
  LEFT JOIN catalogue cat ON c.selected_plan_id = cat.id
  LEFT JOIN users u ON c.created_by = u.id
`;

function formatDateOnly(v) {
  if (v == null || v === "") return null;
  if (v instanceof Date && !Number.isNaN(v.getTime())) {
    return v.toISOString().slice(0, 10);
  }
  const s = String(v);
  return s.length >= 10 ? s.slice(0, 10) : s;
}

function mapInvoiceLedgerRow(r) {
  const planPremium =
    r.plan_price != null && Number(r.plan_price) > 0
      ? Number(r.plan_price)
      : Number(r.subtotal) || 0;
  const tax = Number(r.tax) || 0;
  const total = Number(r.total) != null && !Number.isNaN(Number(r.total))
    ? Number(r.total)
    : planPremium + tax;
  const commission = commissionForSale({
    premium: planPremium,
    durationDays: r.duration_days,
    dateOfBirth: r.date_of_birth,
    fixedDurationPremiums: !!Number(r.fixed_duration_premiums),
  });
  const firstName = r.first_name || "";
  const lastName = r.last_name || "";
  return {
    ...r,
    first_name: firstName,
    last_name: lastName,
    traveller_name: r.traveller_name || [firstName, lastName].filter(Boolean).join(" "),
    date_of_birth: formatDateOnly(r.date_of_birth),
    start_date: formatDateOnly(r.start_date),
    end_date: formatDateOnly(r.end_date),
    destination: r.destination || "",
    plan_premium: planPremium,
    premium_including_tax: total,
    commission,
    agency_commission: commission,
    net_to_transfer: total - commission,
  };
}

/**
 * Paginated rows + total count for the table.
 * Returns { rows, total, page, limit, regionBy }.
 */
export const getInvoiceLedger = async ({
  role,
  agentId,
  agentIds,
  startDate,
  endDate,
  paymentStatus,
  region,
  regionBy = "residence",
  search,
  partnerInsurer,
  page = 1,
  limit = 25
}) => {
  const pool = getPool();
  const pageNum = Math.max(1, Number(page) || 1);
  const limitNum = Math.min(200, Math.max(1, Number(limit) || 25));
  const offset = (pageNum - 1) * limitNum;

  const regionExpr = regionExpression(regionBy);
  const { whereClauses, params } = buildFilters({
    role,
    agentId,
    agentIds,
    startDate,
    endDate,
    paymentStatus,
    region,
    search,
    partnerInsurer
  });

  const whereSql = whereClauses.length
    ? "WHERE " + whereClauses.join(" AND ").replace(/__REGION_EXPR__/g, regionExpr)
    : "";

  const [countRows] = await pool.query(
    `SELECT COUNT(*) AS total ${BASE_FROM} ${whereSql}`,
    params
  );
  const total = Number(countRows[0]?.total) || 0;

  const dataSql = `
    SELECT
      i.id AS invoice_id,
      i.invoice_number,
      i.issue_date,
      i.subtotal,
      i.tax,
      i.total,
      i.payment_status,
      s.id AS sale_id,
      s.policy_number,
      s.certificate_number,
      s.confirmed_at,
      s.plan_price,
      s.received_amount,
      c.id AS case_id,
      c.destination,
      c.start_date,
      c.end_date,
      c.duration_days,
      t.first_name,
      t.last_name,
      CONCAT(t.first_name, ' ', t.last_name) AS traveller_name,
      t.date_of_birth,
      t.country_of_residence AS traveller_country,
      cat.name AS plan_name,
      cat.product_type,
      cat.currency,
      cat.fixed_duration_premiums,
      u.id AS created_by_id,
      u.name AS created_by_name,
      u.country_of_residence AS agent_country,
      u.geographical_location AS agent_geo,
      ${regionExpr} AS region
    ${BASE_FROM}
    ${whereSql}
    ORDER BY i.issue_date DESC, i.id DESC
    LIMIT ? OFFSET ?
  `;
  const [rows] = await pool.query(dataSql, [...params, limitNum, offset]);

  return {
    rows: rows.map(mapInvoiceLedgerRow),
    total,
    page: pageNum,
    limit: limitNum,
    regionBy
  };
};

/**
 * Region summary independent of pagination: one row per region with invoice count
 * and totals. Used to render the strip at the top of the page.
 */
export const getInvoiceRegionSummary = async ({
  role,
  agentId,
  agentIds,
  startDate,
  endDate,
  paymentStatus,
  region,
  regionBy = "residence",
  search,
  partnerInsurer,
  topN = 50
}) => {
  const pool = getPool();
  const regionExpr = regionExpression(regionBy);
  const { whereClauses, params } = buildFilters({
    role,
    agentId,
    agentIds,
    startDate,
    endDate,
    paymentStatus,
    region,
    search,
    partnerInsurer
  });

  const whereSql = whereClauses.length
    ? "WHERE " + whereClauses.join(" AND ").replace(/__REGION_EXPR__/g, regionExpr)
    : "";

  const limitNum = Math.min(200, Math.max(1, Number(topN) || 50));

  const summarySql = `
    SELECT
      ${regionExpr} AS region,
      COUNT(*) AS invoice_count,
      COALESCE(SUM(i.total), 0) AS total_amount,
      COALESCE(SUM(CASE WHEN i.payment_status = 'Paid' THEN i.total ELSE 0 END), 0) AS paid_amount,
      COALESCE(SUM(CASE WHEN i.payment_status <> 'Paid' THEN i.total ELSE 0 END), 0) AS unpaid_amount
    ${BASE_FROM}
    ${whereSql}
    GROUP BY region
    ORDER BY total_amount DESC, invoice_count DESC
    LIMIT ?
  `;

  const [rows] = await pool.query(summarySql, [...params, limitNum]);
  return rows;
};

/** Same query as getInvoiceLedger but with no pagination — used for CSV export. */
export const getInvoiceLedgerAll = async ({
  role,
  agentId,
  agentIds,
  startDate,
  endDate,
  paymentStatus,
  region,
  regionBy = "residence",
  search,
  partnerInsurer,
  hardLimit = 50000
}) => {
  const { rows } = await getInvoiceLedger({
    role,
    agentId,
    agentIds,
    startDate,
    endDate,
    paymentStatus,
    region,
    regionBy,
    search,
    partnerInsurer,
    page: 1,
    limit: Math.min(hardLimit, 50000)
  });
  return rows;
};
