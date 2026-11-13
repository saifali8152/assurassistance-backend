-- ----------------------------------------------------------------------------
-- Milestone 5 — lock an ACCOUNT after repeated wrong passwords.
--
-- The IP limiter already slows one address down; this stops a password being
-- guessed for one account from many addresses. Two nullable/defaulted columns
-- at the end of `users`; existing rows read 0 / NULL = not locked, so nobody
-- is locked out by the migration itself.
--
-- SAFETY: additive only, guarded, re-runnable. No existing value changes.
-- ----------------------------------------------------------------------------
SET @c := (SELECT COUNT(*) FROM information_schema.COLUMNS
           WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'failed_login_count');
SET @s := IF(@c = 0,
  'ALTER TABLE `users` ADD COLUMN `failed_login_count` INT NOT NULL DEFAULT 0',
  'DO 0');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @c := (SELECT COUNT(*) FROM information_schema.COLUMNS
           WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'locked_until');
SET @s := IF(@c = 0,
  'ALTER TABLE `users` ADD COLUMN `locked_until` DATETIME NULL',
  'DO 0');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
