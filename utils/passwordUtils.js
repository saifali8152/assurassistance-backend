// utils/passwordUtils.js
import bcrypt from 'bcryptjs';

export const generateStrongPassword = (length = 12) => {
  const upper = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const lower = "abcdefghijklmnopqrstuvwxyz";
  const numbers = "0123456789";
  const symbols = "!@#$%^&*()_+[]{}|;:,.<>?";

  // Ensure at least one from each group
  const allChars = upper + lower + numbers + symbols;
  const getRandom = (chars) => chars[Math.floor(Math.random() * chars.length)];

  let password = getRandom(upper) + getRandom(lower) + getRandom(numbers) + getRandom(symbols);

  // Fill remaining length with random characters
  for (let i = 4; i < length; i++) {
    password += getRandom(allChars);
  }

  // Shuffle password so it's not predictable
  return password.split('').sort(() => Math.random() - 0.5).join('');
};

// Enhanced password validation
export const validatePasswordStrength = (password) => {
  const errors = [];
  
  if (password.length < 8) {
    errors.push('Password must be at least 8 characters long');
  }
  
  if (password.length > 128) {
    errors.push('Password must be less than 128 characters');
  }
  
  if (!/[a-z]/.test(password)) {
    errors.push('Password must contain at least one lowercase letter');
  }
  
  if (!/[A-Z]/.test(password)) {
    errors.push('Password must contain at least one uppercase letter');
  }
  
  if (!/\d/.test(password)) {
    errors.push('Password must contain at least one number');
  }
  
  if (!/[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]/.test(password)) {
    errors.push('Password must contain at least one special character');
  }
  
  // Check for common weak patterns
  const commonPasswords = [
    'password', '123456', '123456789', 'qwerty', 'abc123', 
    'password123', 'admin', 'letmein', 'welcome', 'monkey'
  ];
  
  if (commonPasswords.includes(password.toLowerCase())) {
    errors.push('Password is too common, please choose a stronger password');
  }
  
  // Check for repeated characters
  if (/(.)\1{2,}/.test(password)) {
    errors.push('Password cannot contain more than 2 consecutive identical characters');
  }
  
  return {
    isValid: errors.length === 0,
    errors
  };
};

// Hash password with configurable rounds
export const hashPassword = async (password) => {
  const rounds = parseInt(process.env.BCRYPT_ROUNDS) || 12;
  return await bcrypt.hash(password, rounds);
};

// Verify password
export const verifyPassword = async (password, hashedPassword) => {
  return await bcrypt.compare(password, hashedPassword);
};

// Check if password has been compromised (basic check)
export const isPasswordCompromised = (password) => {
  // This is a basic implementation. In production, you'd want to use
  // a service like HaveIBeenPwned API
  const compromisedPatterns = [
    /password/i,
    /123456/,
    /qwerty/i,
    /admin/i,
    /test/i
  ];
  
  return compromisedPatterns.some(pattern => pattern.test(password));
};
