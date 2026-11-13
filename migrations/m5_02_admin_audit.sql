-- ----------------------------------------------------------------------------
-- Milestone 5 — audit of sensitive views and changes.
--
-- The existing activity log records actions ("Login", "Created case").
-- This adds what a claims module must also be able to answer: who LOOKED at a
-- claim or opened a document, and who changed a role, a permission, the
-- claims switch or the allowlist. Rows are only ever inserted.
--
-- SAFETY: additive only. One new table.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `admin_audit_log` (
  `id` BIGINT NOT NULL AUTO_INCREMENT,
  `user_id` INT NULL,
  `action` VARCHAR(60) NOT NULL COMMENT 'e.g. claim.view, claim_document.view, role.update',
  `entity` VARCHAR(40) NULL,
  `entity_id` VARCHAR(64) NULL,
  `detail` JSON NULL,
  `ip` VARCHAR(45) NULL,
  `user_agent` VARCHAR(255) NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `ix_admin_audit_entity` (`entity`, `entity_id`),
  KEY `ix_admin_audit_user` (`user_id`, `created_at`),
  KEY `ix_admin_audit_action` (`action`, `created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
