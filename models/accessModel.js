// models/accessModel.js
//
// Milestone 5 (D12) — roles and the permissions they carry.
//
// effective permissions = built-in role matching users.role
//                       ∪ custom role in users.access_role_id (if active)
// and the main admin always has all of them.
//
import getPool from "../utils/db.js";
import { PERMISSION_CODES, isKnownPermission } from "../utils/access/permissions.js";

const TTL_MS = 30_000;
const cache = new Map(); // userId → { perms:Set, at }

export function invalidateAccessCache(userId = null) {
  if (userId == null) cache.clear();
  else cache.delete(Number(userId));
}

/**
 * @param user { id, role } — the JWT payload is enough
 * @returns Set of permission codes
 */
export async function effectivePermissions(user) {
  if (!user) return new Set();
  if (user.role === "admin") return new Set(PERMISSION_CODES);
  const hit = cache.get(Number(user.id));
  if (hit && Date.now() - hit.at < TTL_MS) return hit.perms;
  let perms = new Set();
  try {
    const [rows] = await getPool().query(
      `SELECT DISTINCT p.permission
         FROM users u
         JOIN access_roles r
           -- users predates these tables and may use another collation;
           -- compare as plain utf8mb4 text so it works on any of them.
           ON (CONVERT(r.legacy_role USING utf8mb4) COLLATE utf8mb4_unicode_ci = CONVERT(u.role USING utf8mb4) COLLATE utf8mb4_unicode_ci)
           OR (r.id = u.access_role_id AND r.active = 1)
         JOIN access_role_permissions p ON p.role_id = r.id
        WHERE u.id = ?`,
      [user.id]
    );
    perms = new Set(rows.map((r) => r.permission).filter(isKnownPermission));
  } catch {
    perms = new Set(); // tables missing or DB trouble: no new permissions, old screens unaffected
  }
  cache.set(Number(user.id), { perms, at: Date.now() });
  return perms;
}

export async function hasPermission(user, code) {
  return (await effectivePermissions(user)).has(code);
}

function mapRole(row, perms) {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    description: row.description,
    builtin: Boolean(Number(row.is_builtin)),
    legacyRole: row.legacy_role || null,
    active: Boolean(Number(row.active)),
    permissions: row.code === "admin" ? [...PERMISSION_CODES] : perms,
    users: Number(row.users || 0),
    updatedAt: row.updated_at,
  };
}

export async function listRoles() {
  const pool = getPool();
  const [roles] = await pool.query(
    `SELECT r.*,
            (SELECT COUNT(*) FROM users u
              WHERE (r.legacy_role IS NOT NULL
                     AND CONVERT(u.role USING utf8mb4) COLLATE utf8mb4_unicode_ci = CONVERT(r.legacy_role USING utf8mb4) COLLATE utf8mb4_unicode_ci)
                 OR u.access_role_id = r.id) AS users
       FROM access_roles r ORDER BY r.is_builtin DESC, r.name`
  );
  const [perms] = await pool.query(`SELECT role_id, permission FROM access_role_permissions`);
  return roles.map((r) => mapRole(r, perms.filter((p) => p.role_id === r.id).map((p) => p.permission).filter(isKnownPermission)));
}

export async function getRole(id) {
  return (await listRoles()).find((r) => r.id === Number(id)) || null;
}

const CODE = /^[a-z][a-z0-9_]{1,59}$/;

export function validateRoleInput(body, { existing = null } = {}) {
  const errors = {};
  const name = String(body?.name ?? existing?.name ?? "").trim();
  if (!name || name.length > 100) errors.name = "A name of 1 to 100 characters is required";
  const code = existing ? existing.code : String(body?.code || name).toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 60);
  if (!existing && !CODE.test(code)) errors.code = "Use lowercase letters, digits and _";
  const permissions = Array.isArray(body?.permissions) ? [...new Set(body.permissions)] : existing?.permissions || [];
  const unknown = permissions.filter((p) => !isKnownPermission(p));
  if (unknown.length) errors.permissions = `Unknown permission(s): ${unknown.join(", ")}`;
  const description = body?.description === undefined ? existing?.description ?? null : String(body.description || "").slice(0, 500) || null;
  const active = body?.active === undefined ? existing?.active ?? true : Boolean(body.active);
  return Object.keys(errors).length ? { ok: false, errors } : { ok: true, value: { name, code, permissions, description, active } };
}

export async function createRole(value, { userId = null } = {}) {
  const conn = await getPool().getConnection();
  try {
    await conn.beginTransaction();
    const [r] = await conn.execute(
      `INSERT INTO access_roles (code, name, description, is_builtin, active, created_by_user_id, updated_by_user_id)
       VALUES (?, ?, ?, 0, ?, ?, ?)`,
      [value.code, value.name, value.description, value.active ? 1 : 0, userId, userId]
    );
    for (const p of value.permissions) {
      await conn.execute(`INSERT INTO access_role_permissions (role_id, permission) VALUES (?, ?)`, [r.insertId, p]);
    }
    await conn.commit();
    invalidateAccessCache();
    return r.insertId;
  } catch (err) {
    await conn.rollback();
    if (err?.code === "ER_DUP_ENTRY") return { error: "duplicate_code" };
    throw err;
  } finally {
    conn.release();
  }
}

/**
 * Built-in roles keep their code and name; the admin role cannot be edited at
 * all (it always has everything). Permissions of the other built-ins CAN be
 * extended by the main admin — that is how e.g. every sub-admin gets claims.
 */
export async function updateRole(id, value, { userId = null } = {}) {
  const role = await getRole(id);
  if (!role) return { ok: false, reason: "not_found" };
  if (role.code === "admin") return { ok: false, reason: "admin_role_fixed" };
  const conn = await getPool().getConnection();
  try {
    await conn.beginTransaction();
    if (!role.builtin) {
      await conn.execute(
        `UPDATE access_roles SET name = ?, description = ?, active = ?, updated_by_user_id = ? WHERE id = ?`,
        [value.name, value.description, value.active ? 1 : 0, userId, id]
      );
    } else {
      await conn.execute(`UPDATE access_roles SET description = ?, updated_by_user_id = ? WHERE id = ?`, [value.description, userId, id]);
    }
    await conn.execute(`DELETE FROM access_role_permissions WHERE role_id = ?`, [id]);
    for (const p of value.permissions) {
      await conn.execute(`INSERT INTO access_role_permissions (role_id, permission) VALUES (?, ?)`, [id, p]);
    }
    await conn.commit();
    invalidateAccessCache();
    return { ok: true, before: role, after: await getRole(id) };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

/** Give a user a custom role (or remove it with null). Built-in roles are not assignable here — they follow users.role. */
/**
 * The people who can sign in to the admin panel, with the custom role each one
 * carries — for the Roles & permissions screen. Agents use their own portal,
 * where none of the new screens exist, so they are not listed.
 */
export async function listStaffUsers() {
  const [rows] = await getPool().query(
    `SELECT u.id, u.name, u.email, u.role, u.access_role_id, u.locked_until
       FROM users u
      WHERE u.role IN ('admin', 'sub_admin', 'insurer_supervisor')
      ORDER BY (u.role = 'admin') DESC, u.name, u.id`
  );
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    email: r.email,
    role: r.role,
    accessRoleId: r.access_role_id ?? null,
    lockedUntil: r.locked_until && new Date(r.locked_until) > new Date() ? r.locked_until : null,
  }));
}

export async function assignRole(targetUserId, roleId, { userId = null } = {}) {
  const pool = getPool();
  const [[user]] = await pool.query(`SELECT id, role, access_role_id FROM users WHERE id = ?`, [targetUserId]);
  if (!user) return { ok: false, reason: "user_not_found" };
  if (roleId !== null) {
    const role = await getRole(roleId);
    if (!role) return { ok: false, reason: "role_not_found" };
    if (role.builtin) return { ok: false, reason: "builtin_not_assignable" };
    if (!role.active) return { ok: false, reason: "role_inactive" };
  }
  await pool.execute(`UPDATE users SET access_role_id = ? WHERE id = ?`, [roleId, targetUserId]);
  invalidateAccessCache(targetUserId);
  return { ok: true, before: user.access_role_id ?? null, after: roleId, by: userId };
}
