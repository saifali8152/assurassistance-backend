//role acess midldleware
export const adminOnly = (req, res, next) => {
    if (!req.user || !req.user.is_admin) {
      return res.status(403).json({ message: 'Forbidden: admin only' });
    }
    next();
  };
  