-- Agency / partner supervision history (who manages which travel agency, by period).
-- Current owner remains users.created_by_id on the top-level agent row.
-- Historical periods are stored here so reassignment never loses audit trail.

CREATE TABLE IF NOT EXISTS `agency_supervision_history` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `agency_user_id` INT NOT NULL COMMENT 'Top-level agency (role=agent, parent_agent_id NULL)',
  `supervisor_user_id` INT NULL COMMENT 'Admin or sub_admin who supervised during this period',
  `effective_from` DATE NOT NULL,
  `effective_to` DATE NULL COMMENT 'NULL = current / ongoing period',
  `changed_by_user_id` INT NOT NULL COMMENT 'Admin who performed the change',
  `reason` VARCHAR(500) NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_agency_from` (`agency_user_id`, `effective_from`),
  KEY `idx_supervisor` (`supervisor_user_id`),
  CONSTRAINT `fk_ash_agency` FOREIGN KEY (`agency_user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_ash_supervisor` FOREIGN KEY (`supervisor_user_id`) REFERENCES `users` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_ash_changed_by` FOREIGN KEY (`changed_by_user_id`) REFERENCES `users` (`id`) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
