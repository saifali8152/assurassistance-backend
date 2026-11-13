// middlewares/permissionMiddleware.js
//
// Milestone 5 (D12): gate a NEW endpoint on a permission. Use after
// `authenticate`. Existing endpoints keep their role middlewares untouched.
//
import { effectivePermissions } from "../models/accessModel.js";

export function requirePermission(...codes) {
  return async (req, res, next) => {
    if (!req.user) return res.status(401).json({ message: "Not authenticated" });
    const perms = await effectivePermissions(req.user);
    if (codes.some((c) => perms.has(c))) return next();
    return res.status(403).json({ message: "Forbidden: missing permission", required: codes });
  };
}
