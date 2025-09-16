// src/utils/generateToken.js
import jwt from 'jsonwebtoken';
import dotenv from 'dotenv';
dotenv.config();


//genration of token
export default function generateToken(user) {
  const payload = {
    id: user.id,
    email: user.email,
    is_admin: user.is_admin ? 1 : 0
  };

  return jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: process.env.JWT_EXPIRES_IN || '1h' });
}
