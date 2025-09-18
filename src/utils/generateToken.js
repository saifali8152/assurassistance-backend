// src/utils/generateToken.js
import jwt from 'jsonwebtoken';
import dotenv from 'dotenv';
dotenv.config();

export default function generateToken(user) {
  const payload = {
    id: user.id,
    email: user.email,
    role: user.role_name || user.role // so we return role instead of is_admin
  };

  return jwt.sign(payload, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || '1h'
  });
}
