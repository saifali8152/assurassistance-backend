// controllers/partnerClaimsController.js
//
// Milestone 4/5 (D10) — claim STATUS for partners over the 3rd-party API.
//
// A partner sees claims on the policies its own account can see — the same
// visibility the cases and sales endpoints already apply:
//   admin              every claim on a platform policy, and imported ones
//   sub_admin / agent  claims on policies sold by them or their agents
//   insurer_supervisor claims on policies of their insurer's plans
// Test claims are never returned.
//
// What a claim looks like here is deliberately thin: reference, status, dates,
// type, policy number. Never the customer's description, the documents, the
// passport or the WhatsApp number.
//
import getPool from "../utils/db.js";
import { getAgentVisibilityIds, findUserById } from "../models/userModel.js";

const STATUS_FOR_API = new Set(["submitted", "under_review", "closed"]);

async function visibilityClause(user) {
  if (!user) return { sql: "1 = 0", params: [] };
  if (user.role === "admin") return { sql: "1 = 1", params: [] };
  if (user.role === "insurer_supervisor") {
    const u = await findUserById(user.id);
    if (!u?.partner_insurer) return { sql: "1 = 0", params: [] };
    return { sql: "cat.partner_insurer = ?", params: [u.partner_insurer] };
  }
  const ids = await getAgentVisibilityIds(user.id);
  if (!ids?.length) return { sql: "1 = 0", params: [] };
  return { sql: `cs.created_by IN (${ids.map(() => "?").join(",")})`, params: ids };
}

const SELECT = `
  SELECT c.reference, c.status, c.submitted_at, c.closed_at, c.updated_at, c.policy_number, c.priority,
         c.category_code, c.subcategory_code, c.sale_id, c.external_policy_id,
         cat_c.name_fr AS category_fr, cat_c.name_en AS category_en, sub_c.name_fr AS subcategory_fr, sub_c.name_en AS subcategory_en
    FROM claims c
    LEFT JOIN sales s ON s.id = c.sale_id
    LEFT JOIN cases cs ON cs.id = s.case_id
    LEFT JOIN catalogue cat ON cat.id = cs.selected_plan_id
    LEFT JOIN claim_categories cat_c ON cat_c.code = c.category_code
    LEFT JOIN claim_categories sub_c ON sub_c.code = c.subcategory_code`;

function present(r) {
  return {
    reference: r.reference,
    status: r.status,
    policyNumber: r.policy_number,
    policySource: r.sale_id ? "platform" : "imported",
    priority: r.priority,
    category: { code: r.category_code, fr: r.category_fr, en: r.category_en },
    subcategory: { code: r.subcategory_code, fr: r.subcategory_fr, en: r.subcategory_en },
    submittedAt: r.submitted_at,
    closedAt: r.closed_at,
    updatedAt: r.updated_at,
  };
}

async function query(user, extraSql, extraParams, { limit = 50, offset = 0 } = {}) {
  const vis = await visibilityClause(user);
  // Imported policies have no seller on the platform: admin keys only.
  const importedRule = user?.role === "admin" ? "" : " AND c.sale_id IS NOT NULL";
  const [rows] = await getPool().query(
    `${SELECT}
      WHERE c.status IN ('submitted','under_review','closed') AND c.is_test = 0
        AND (${vis.sql})${importedRule} ${extraSql}
      ORDER BY c.submitted_at DESC LIMIT ? OFFSET ?`,
    [...vis.params, ...extraParams, limit, offset]
  );
  return rows;
}

export const getClaimStatus = async (req, res) => {
  try {
    const ref = String(req.params.reference || "").trim().toUpperCase();
    const rows = await query(req.user, "AND c.reference = ?", [ref], { limit: 1 });
    if (!rows[0] || !STATUS_FOR_API.has(rows[0].status)) {
      return res.status(404).json({ success: false, error: { code: "not_found", message: "No claim with this reference is visible to this key" } });
    }
    res.json({ success: true, data: present(rows[0]) });
  } catch (err) {
    console.error("partner claims:", err);
    res.status(500).json({ success: false, error: { code: "server_error", message: "Server error" } });
  }
};

export const listClaimStatuses = async (req, res) => {
  try {
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 50));
    const page = Math.max(1, Number(req.query.page) || 1);
    const extra = [];
    const params = [];
    if (req.query.policyNumber) { extra.push("AND c.policy_number = ?"); params.push(String(req.query.policyNumber).trim().toUpperCase()); }
    if (STATUS_FOR_API.has(req.query.status)) { extra.push("AND c.status = ?"); params.push(req.query.status); }
    if (req.query.updatedSince) {
      const since = new Date(String(req.query.updatedSince));
      if (Number.isNaN(since.getTime())) {
        return res.status(400).json({ success: false, error: { code: "invalid_parameter", message: "updatedSince must be an ISO 8601 date or date-time" } });
      }
      extra.push("AND c.updated_at >= ?"); params.push(since);
    }
    if (req.query.status && !STATUS_FOR_API.has(req.query.status)) {
      return res.status(400).json({ success: false, error: { code: "invalid_parameter", message: "status must be one of submitted, under_review, closed" } });
    }
    const rows = await query(req.user, extra.join(" "), params, { limit, offset: (page - 1) * limit });
    res.json({ success: true, data: rows.map(present), page, limit });
  } catch (err) {
    console.error("partner claims:", err);
    res.status(500).json({ success: false, error: { code: "server_error", message: "Server error" } });
  }
};
