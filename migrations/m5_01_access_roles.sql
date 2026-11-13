-- ----------------------------------------------------------------------------
-- Milestone 5 — roles and permissions (D12).
--
-- WHAT EXISTS TODAY, AND STAYS: users.role (admin / sub_admin /
-- insurer_supervisor / agent) and every check built on it. Nothing here
-- changes what any existing user can see or do.
--
-- WHAT IS ADDED: named permissions for the NEW features only (claims,
-- imported policies, the simulator). Each of the four existing roles is
-- recorded as a built-in access role; the main admin gets every new
-- permission, the other three get none — exactly today's situation, since
-- none of them has claims today.
--
-- A user's permissions = those of the built-in role matching users.role,
-- plus those of the custom role in users.access_role_id, if any. So a
-- custom role only ever ADDS. The main admin can create custom roles and
-- assign them; a "Claims handler" template ships ready to assign.
--
-- SAFETY: additive only. Two new tables; one nullable column added at the end
-- of `users` (instant on MySQL 8 / MariaDB 10.3+). No foreign key onto
-- `users`, no existing row changed. Re-runnable.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `access_roles` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `code` VARCHAR(60) NOT NULL,
  `name` VARCHAR(100) NOT NULL,
  `description` VARCHAR(500) NULL,
  `is_builtin` TINYINT(1) NOT NULL DEFAULT 0 COMMENT 'Mirrors a users.role value; cannot be renamed or deleted',
  `legacy_role` ENUM('admin','sub_admin','insurer_supervisor','agent') NULL COMMENT 'Set on built-in roles only',
  `active` TINYINT(1) NOT NULL DEFAULT 1,
  `created_by_user_id` INT NULL,
  `updated_by_user_id` INT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_access_roles_code` (`code`),
  UNIQUE KEY `uq_access_roles_legacy` (`legacy_role`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `access_role_permissions` (
  `role_id` INT NOT NULL,
  `permission` VARCHAR(60) NOT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`role_id`, `permission`),
  CONSTRAINT `fk_access_role_permissions_role` FOREIGN KEY (`role_id`) REFERENCES `access_roles` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

SET @c := (SELECT COUNT(*) FROM information_schema.COLUMNS
           WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'access_role_id');
SET @s := IF(@c = 0,
  'ALTER TABLE `users` ADD COLUMN `access_role_id` INT NULL COMMENT ''Optional custom role: adds permissions on top of users.role''',
  'DO 0');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- Built-in roles: one per existing users.role value.
INSERT IGNORE INTO `access_roles` (`code`, `name`, `description`, `is_builtin`, `legacy_role`) VALUES
  ('admin', 'Administrator', 'Main administrator. Every permission, always.', 1, 'admin'),
  ('sub_admin', 'Sub-administrator', 'As today. No claims permissions unless a custom role adds them.', 1, 'sub_admin'),
  ('insurer_supervisor', 'Insurer supervisor', 'As today. No claims permissions unless a custom role adds them.', 1, 'insurer_supervisor'),
  ('agent', 'Agent', 'As today. No claims permissions unless a custom role adds them.', 1, 'agent'),
  ('claims_handler', 'Claims handler', 'Template: sees claims and their documents and updates their status. Assign it to a user to add these permissions.', 0, NULL);

-- The main admin has every new permission.
INSERT IGNORE INTO `access_role_permissions` (`role_id`, `permission`)
SELECT r.id, p.perm FROM `access_roles` r
JOIN (
  SELECT 'claims.view' AS perm UNION ALL SELECT 'claims.update_status' UNION ALL SELECT 'claims.documents'
  UNION ALL SELECT 'claims.settings' UNION ALL SELECT 'claims.categories' UNION ALL SELECT 'claims.activate'
  UNION ALL SELECT 'claims.allowlist' UNION ALL SELECT 'policies.import' UNION ALL SELECT 'simulator.use'
  UNION ALL SELECT 'access.manage'
) p
WHERE r.code = 'admin';

-- The Claims handler template.
INSERT IGNORE INTO `access_role_permissions` (`role_id`, `permission`)
SELECT r.id, p.perm FROM `access_roles` r
JOIN (SELECT 'claims.view' AS perm UNION ALL SELECT 'claims.update_status' UNION ALL SELECT 'claims.documents') p
WHERE r.code = 'claims_handler';
