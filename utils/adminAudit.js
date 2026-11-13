// utils/adminAudit.js
//
// Milestone 5 — "who looked at this claim / opened this document / changed
// this role?" One insert per event into admin_audit_log. Never throws: an
// audit hiccup must not stop the screen it is recording.
//
import getPool from "./db.js";

export async function logAudit(req, action, { entity = null, entityId = null, detail = null } = {}) {
  try {
    await getPool().execute(
      `INSERT INTO admin_audit_log (user_id, action, entity, entity_id, detail, ip, user_agent) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        req?.user?.id ?? null,
        String(action).slice(0, 60),
        entity ? String(entity).slice(0, 40) : null,
        entityId != null ? String(entityId).slice(0, 64) : null,
        detail ? JSON.stringify(detail) : null,
        (req?.ip || req?.headers?.["x-forwarded-for"] || "").toString().slice(0, 45) || null,
        (req?.headers?.["user-agent"] || "").toString().slice(0, 255) || null,
      ]
    );
  } catch (err) {
    console.warn("admin audit: could not record", action, err?.message);
  }
}

export async function listAudit({ entity = null, entityId = null, userId = null, action = null, page = 1, limit = 50 } = {}) {
  const where = [];
  const params = [];
  if (entity) { where.push("a.entity = ?"); params.push(entity); }
  if (entityId) { where.push("a.entity_id = ?"); params.push(String(entityId)); }
  if (userId) { where.push("a.user_id = ?"); params.push(userId); }
  if (action) { where.push("a.action LIKE ?"); params.push(`${action}%`); }
  const lim = Math.min(200, Math.max(1, Number(limit) || 50));
  const off = (Math.max(1, Number(page) || 1) - 1) * lim;
  const [rows] = await getPool().query(
    `SELECT a.id, a.user_id, u.name AS user_name, a.action, a.entity, a.entity_id, a.detail, a.ip, a.created_at
       FROM admin_audit_log a LEFT JOIN users u ON u.id = a.user_id
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY a.id DESC LIMIT ? OFFSET ?`,
    [...params, lim, off]
  );
  return rows;
}
