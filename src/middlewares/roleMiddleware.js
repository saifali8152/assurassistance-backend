//role acess midldleware
export const adminOnly = (req, res, next) => {
  if (!req.user || req.user.role !== 'Admin') {
    return res.status(403).json({ message: 'Forbidden: admin only' });
  }
  next();
};
