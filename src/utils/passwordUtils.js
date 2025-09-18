// utils/passwordUtils.js
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
