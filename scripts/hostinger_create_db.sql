-- Run this on your Hostinger VPS as MySQL root to create the database and app user.
-- Usage: sudo mysql -u root -p < scripts/hostinger_create_db.sql
-- Then replace YOUR_STRONG_PASSWORD with your chosen password before running, or run line by line in mysql.

CREATE DATABASE IF NOT EXISTS assurassistance CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER IF NOT EXISTS 'assurapp'@'localhost' IDENTIFIED BY 'YOUR_STRONG_PASSWORD';
GRANT ALL PRIVILEGES ON assurassistance.* TO 'assurapp'@'localhost';
FLUSH PRIVILEGES;
