-- ----------------------------------------------------------------------------
-- Milestone 4 — feature flags, built before anything they guard.
--
-- The purchase flow is live. The claims module ships into the same process and
-- the same WhatsApp number, so it has to be provably invisible until the client
-- switches it on — from the first day, not bolted on at the end.
--
--   feature_flags           one row per switch; `claims_enabled` starts OFF
--   feature_flag_allowlist  WhatsApp numbers that may use a feature while it is
--                           off, so the client's own staff can test in production
--   feature_flag_audit      every change: who, when, from what, to what
--
-- No foreign keys to `users`: an audit row must survive whatever happens to the
-- account that made the change.
--
-- SAFETY: additive only. New tables; no existing table is altered. The seed row
-- uses INSERT IGNORE, so re-running never switches a flag back off once the
-- client has turned it on.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `feature_flags` (
  `flag_key` VARCHAR(80) NOT NULL,
  `enabled` TINYINT(1) NOT NULL DEFAULT 0,
  `description` VARCHAR(255) NULL,
  `updated_by_user_id` INT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`flag_key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `feature_flag_allowlist` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `flag_key` VARCHAR(80) NOT NULL,
  `wa_number` VARCHAR(32) NOT NULL COMMENT 'Digits only, with country code — compared exactly',
  `label` VARCHAR(120) NULL COMMENT 'Who this number belongs to, for the admin screen',
  `added_by_user_id` INT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_flag_allowlist` (`flag_key`, `wa_number`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `feature_flag_audit` (
  `id` BIGINT NOT NULL AUTO_INCREMENT,
  `flag_key` VARCHAR(80) NOT NULL,
  `action` ENUM('enable','disable','allowlist_add','allowlist_remove') NOT NULL,
  `old_value` TINYINT(1) NULL,
  `new_value` TINYINT(1) NULL,
  `detail` VARCHAR(255) NULL COMMENT 'E.g. the allowlisted number, masked',
  `changed_by_user_id` INT NULL,
  `ip` VARCHAR(64) NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `ix_flag_audit_key` (`flag_key`, `created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT IGNORE INTO `feature_flags` (`flag_key`, `enabled`, `description`) VALUES
  ('claims_enabled', 0, 'Claims on WhatsApp — when off, only allowlisted numbers can use it');
