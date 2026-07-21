import getPool from "../utils/db.js";
import { commissionForSale } from "../utils/commissionRules.js";

/**
 * All confirmed sales for the given creator account ids within a period,
 * with the invoice-only commission computed per line.
 */
export const getPartnerSalesForPeriod = async ({ accountIds, startDate, endDate }) => {
  const pool = getPool();
  if (!accountIds || accountIds.length === 0) return [];

  const placeholders = accountIds.map(() => "?").join(",");
  const [rows] = await pool.query(
    `SELECT
       s.id AS sale_id,
       s.case_id,
       CONCAT(t.first_name, ' ', t.last_name) AS traveller_name,
       t.phone AS traveller_phone,
       t.date_of_birth,
       cat.name AS plan_name,
       cat.partner_insurer_logo,
       s.policy_number,
       s.certificate_number,
       CASE WHEN s.plan_price IS NOT NULL AND s.plan_price > 0
            THEN s.plan_price ELSE s.premium_amount END AS plan_premium,
       COALESCE(s.tax, 0) AS tax,
       COALESCE(s.received_amount, 0) AS received_amount,
       s.payment_status,
       s.confirmed_at,
       s.currency,
       c.duration_days,
       u.name AS created_by_name
     FROM sales s
     JOIN cases c ON s.case_id = c.id
     JOIN travellers t ON c.traveller_id = t.id
     LEFT JOIN catalogue cat ON c.selected_plan_id = cat.id
     LEFT JOIN users u ON c.created_by = u.id
     WHERE c.created_by IN (${placeholders})
       AND s.confirmed_at >= ? AND s.confirmed_at <= ?
     ORDER BY s.confirmed_at DESC, s.id DESC`,
    [...accountIds, `${startDate} 00:00:00`, `${endDate} 23:59:59`]
  );

  return rows.map((r) => {
    const planPremium = Number(r.plan_premium) || 0;
    const tax = Number(r.tax) || 0;
    return {
      sale_id: r.sale_id,
      case_id: r.case_id,
      traveller_name: r.traveller_name,
      traveller_phone: r.traveller_phone || "",
      plan_name: r.plan_name || "",
      partner_insurer_logo: r.partner_insurer_logo || null,
      policy_number: r.policy_number,
      certificate_number: r.certificate_number,
      plan_premium: planPremium,
      tax,
      total: planPremium + tax,
      received_amount: Number(r.received_amount) || 0,
      payment_status: r.payment_status,
      confirmed_at: r.confirmed_at,
      currency: r.currency || "XOF",
      created_by_name: r.created_by_name || "",
      commission: commissionForSale({
        premium: planPremium,
        durationDays: r.duration_days,
        dateOfBirth: r.date_of_birth,
      }),
    };
  });
};

/**
 * Lean period totals for the dashboard reminder.
 * accountIds = null means all sales (admin); otherwise scoped to those case creators.
 */
export const getCommissionSummary = async ({ accountIds = null, startDate, endDate }) => {
  const pool = getPool();
  if (accountIds && accountIds.length === 0) {
    return { totalSales: 0, totalPremiums: 0, totalCollected: 0, totalCommissions: 0, netToTransfer: 0 };
  }

  const where = ["s.confirmed_at >= ?", "s.confirmed_at <= ?"];
  const params = [`${startDate} 00:00:00`, `${endDate} 23:59:59`];
  if (accountIds) {
    where.unshift(`c.created_by IN (${accountIds.map(() => "?").join(",")})`);
    params.unshift(...accountIds);
  }

  const [rows] = await pool.query(
    `SELECT
       CASE WHEN s.plan_price IS NOT NULL AND s.plan_price > 0
            THEN s.plan_price ELSE s.premium_amount END AS plan_premium,
       COALESCE(s.tax, 0) AS tax,
       COALESCE(s.received_amount, 0) AS received_amount,
       c.duration_days,
       t.date_of_birth
     FROM sales s
     JOIN cases c ON s.case_id = c.id
     JOIN travellers t ON c.traveller_id = t.id
     WHERE ${where.join(" AND ")}`,
    params
  );

  const acc = { totalSales: rows.length, totalPremiums: 0, totalCollected: 0, totalCommissions: 0 };
  for (const r of rows) {
    const premium = Number(r.plan_premium) || 0;
    acc.totalPremiums += premium + (Number(r.tax) || 0);
    acc.totalCollected += Number(r.received_amount) || 0;
    acc.totalCommissions += commissionForSale({
      premium,
      durationDays: r.duration_days,
      dateOfBirth: r.date_of_birth,
    });
  }
  return { ...acc, netToTransfer: acc.totalPremiums - acc.totalCommissions };
};

export const computeInvoiceTotals = (lines, { discountPct = 0 } = {}) => {
  const gross = lines.reduce(
    (acc, l) => {
      acc.totalPremiums += Number(l.total) || 0;
      acc.totalCommissions += Number(l.commission) || 0;
      acc.totalReceived += Number(l.received_amount) || 0;
      return acc;
    },
    { totalPremiums: 0, totalCommissions: 0, totalReceived: 0 }
  );

  let pct = Number(discountPct);
  if (!Number.isFinite(pct) || pct < 0) pct = 0;
  if (pct > 100) pct = 100;
  const factor = 1 - pct / 100;
  const round2 = (n) => Math.round(Number(n) * 100) / 100;

  const totalPremiums = round2(gross.totalPremiums * factor);
  const totalCommissions = round2(gross.totalCommissions * factor);

  return {
    discountPct: pct,
    totalPremiumsGross: round2(gross.totalPremiums),
    totalCommissionsGross: round2(gross.totalCommissions),
    totalPremiums,
    totalCommissions,
    totalReceived: round2(gross.totalReceived),
    netToTransfer: round2(totalPremiums - totalCommissions),
  };
};
