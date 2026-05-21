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

/** Convenience helper for inline checks. */
export const isPrivilegedRole = (role) => role === 'admin' || role === 'sub_admin';
