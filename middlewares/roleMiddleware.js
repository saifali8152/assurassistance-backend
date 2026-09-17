export const adminOnly = (req, res, next) => {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ message: 'Forbidden: admin only' });
  }
  next();
};

/** Allowed for either an admin or a sub-administrator (field sales rep). */
export const adminOrSubAdmin = (req, res, next) => {
  if (!req.user || (req.user.role !== 'admin' && req.user.role !== 'sub_admin')) {
    return res.status(403).json({ message: 'Forbidden: admin or sub-administrator only' });
  }
  next();
};

/**
 * Admin, sub-administrator, or insurer supervisor — roles that manage agencies
 * and issue policies from the staff shell.
 */
export const adminOrAgencyManager = (req, res, next) => {
  if (!req.user || !isAgencyManagerRole(req.user.role)) {
    return res.status(403).json({
      message: 'Forbidden: admin, sub-administrator, or insurer supervisor only'
    });
  }
  next();
};

/** Staff roles that use the admin shell and can create agencies. */
export const isAgencyManagerRole = (role) =>
  role === 'admin' || role === 'sub_admin' || role === 'insurer_supervisor';

/**
 * Roles that see the full catalogue (admin / sub-admin).
 * Insurer supervisors are privileged for case edits but catalogue is plan-scoped.
 */
export const isPrivilegedRole = (role) => role === 'admin' || role === 'sub_admin';

/** Normalize an insurer key slug (lowercase, underscores). */
export const normalizePartnerInsurer = (value) => {
  const s = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return s || null;
};
