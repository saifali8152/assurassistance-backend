// controllers/accessController.js
//
// Milestone 5 (D12) — the Roles & permissions screen, for the main admin.
//
import { PERMISSIONS } from "../utils/access/permissions.js";
import {
  listRoles, getRole, validateRoleInput, createRole, updateRole, assignRole, effectivePermissions, listStaffUsers,
} from "../models/accessModel.js";
import { logAudit, listAudit } from "../utils/adminAudit.js";

export const getPermissionCatalogue = (_req, res) => res.json({ permissions: PERMISSIONS });

export const getMyPermissions = async (req, res) => {
  const perms = await effectivePermissions(req.user);
  res.json({ role: req.user.role, permissions: [...perms] });
};

export const getRoles = async (_req, res) => {
  try {
    res.json({ roles: await listRoles() });
  } catch (err) {
    console.error("access: list roles", err);
    res.status(500).json({ message: "Could not load roles" });
  }
};

export const postRole = async (req, res) => {
  const v = validateRoleInput(req.body);
  if (!v.ok) return res.status(400).json({ message: "Invalid role", errors: v.errors });
  const id = await createRole(v.value, { userId: req.user.id });
  if (id?.error === "duplicate_code") return res.status(409).json({ message: "A role with this name already exists" });
  await logAudit(req, "role.create", { entity: "access_role", entityId: id, detail: v.value });
  res.status(201).json({ role: await getRole(id) });
};

export const putRole = async (req, res) => {
  const existing = await getRole(req.params.id);
  if (!existing) return res.status(404).json({ message: "Role not found" });
  const v = validateRoleInput(req.body, { existing });
  if (!v.ok) return res.status(400).json({ message: "Invalid role", errors: v.errors });
  const r = await updateRole(existing.id, v.value, { userId: req.user.id });
  if (!r.ok) {
    return res.status(r.reason === "admin_role_fixed" ? 400 : 404).json({
      message: r.reason === "admin_role_fixed" ? "The administrator role always has every permission and cannot be edited" : "Role not found",
    });
  }
  await logAudit(req, "role.update", {
    entity: "access_role",
    entityId: existing.id,
    detail: { before: { name: r.before.name, permissions: r.before.permissions, active: r.before.active }, after: { name: r.after.name, permissions: r.after.permissions, active: r.after.active } },
  });
  res.json({ role: r.after });
};

export const getStaffUsers = async (_req, res) => {
  try {
    res.json({ users: await listStaffUsers() });
  } catch (err) {
    console.error("access: list users", err);
    res.status(500).json({ message: "Could not load users" });
  }
};

export const putUserRole = async (req, res) => {
  const roleId = req.body?.roleId === null || req.body?.roleId === "" ? null : Number(req.body?.roleId);
  if (roleId !== null && !Number.isInteger(roleId)) return res.status(400).json({ message: "roleId must be a role id or null" });
  const r = await assignRole(Number(req.params.id), roleId, { userId: req.user.id });
  if (!r.ok) {
    const status = r.reason.endsWith("not_found") ? 404 : 400;
    const messages = {
      user_not_found: "User not found",
      role_not_found: "Role not found",
      builtin_not_assignable: "Built-in roles follow the user's main role; assign a custom role here",
      role_inactive: "This role is inactive",
    };
    return res.status(status).json({ message: messages[r.reason] || r.reason });
  }
  await logAudit(req, "user.role_assign", { entity: "user", entityId: req.params.id, detail: { before: r.before, after: r.after } });
  res.json({ ok: true });
};

export const getAudit = async (req, res) => {
  const rows = await listAudit({
    entity: req.query.entity || null,
    entityId: req.query.entityId || null,
    userId: req.query.userId ? Number(req.query.userId) : null,
    action: req.query.action || null,
    page: req.query.page,
    limit: req.query.limit,
  });
  res.json({ entries: rows });
};
