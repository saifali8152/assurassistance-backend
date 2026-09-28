-- ----------------------------------------------------------------------------
-- Milestone 2 — WhatsApp conversation tables.
--
--   whatsapp_sessions  one row per customer conversation; holds the step the
--                      customer is on and the data collected so far, so a
--                      dropped conversation can resume where it left off.
--   whatsapp_messages  inbound/outbound archive for audit, debugging and
--                      idempotency (Meta re-delivers webhooks).
--   whatsapp_flows     the purchase flow stored as DATA, so the superadmin can
--                      change prompts and ordering without a release.
--
-- SAFETY: additive only. Three new tables; nothing existing is altered.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `whatsapp_sessions` (
  `id` BIGINT NOT NULL AUTO_INCREMENT,
  `wa_number` VARCHAR(32) NOT NULL COMMENT 'E.164, no + prefix, as Meta sends it',
  `wa_profile_name` VARCHAR(255) NULL,
  `language` ENUM('fr','en') NOT NULL DEFAULT 'fr',
  `flow_key` VARCHAR(60) NOT NULL DEFAULT 'purchase',
  `current_step` VARCHAR(80) NULL,
  `step_history` JSON NULL COMMENT 'Visited step keys, newest last — powers BACK',
  `collected_data` JSON NULL COMMENT 'Partial traveller/case data gathered so far',
  `retry_count` SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  `status` ENUM('active','completed','expired','cancelled','escalated') NOT NULL DEFAULT 'active',
  `customer_message_count` INT UNSIGNED NOT NULL DEFAULT 0 COMMENT 'Instrumentation for the 6-8 message target',
  `traveller_id` INT NULL,
  `case_id` INT NULL,
  `quote_reference` VARCHAR(50) NULL,
  -- Generated column so MySQL can enforce "at most one active session per number".
  -- NULL for every non-active row, and a UNIQUE index ignores NULLs.
  `active_lock` VARCHAR(32) GENERATED ALWAYS AS (IF(`status` = 'active', `wa_number`, NULL)) STORED,
  `last_activity_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `expires_at` DATETIME NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_whatsapp_sessions_active` (`active_lock`),
  KEY `ix_whatsapp_sessions_number` (`wa_number`),
  KEY `ix_whatsapp_sessions_status` (`status`),
  KEY `ix_whatsapp_sessions_expires` (`expires_at`),
  KEY `ix_whatsapp_sessions_case` (`case_id`),
  CONSTRAINT `fk_whatsapp_sessions_case`
    FOREIGN KEY (`case_id`) REFERENCES `cases` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_whatsapp_sessions_traveller`
    FOREIGN KEY (`traveller_id`) REFERENCES `travellers` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `whatsapp_messages` (
  `id` BIGINT NOT NULL AUTO_INCREMENT,
  `session_id` BIGINT NULL,
  `wa_number` VARCHAR(32) NOT NULL,
  `direction` ENUM('inbound','outbound') NOT NULL,
  -- Meta's message id. UNIQUE gives us free idempotency on webhook retries;
  -- MySQL permits many NULLs, which covers queued outbound rows.
  `wa_message_id` VARCHAR(128) NULL,
  `message_type` VARCHAR(40) NOT NULL DEFAULT 'text',
  `body` TEXT NULL COMMENT 'Human-readable text, for support and debugging',
  `payload` JSON NULL COMMENT 'Full normalised payload',
  `step_key` VARCHAR(80) NULL COMMENT 'Flow step this message belongs to',
  `status` VARCHAR(40) NULL COMMENT 'queued | sent | delivered | read | failed',
  `error_code` VARCHAR(40) NULL,
  `error_message` VARCHAR(500) NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_whatsapp_messages_wa_id` (`wa_message_id`),
  KEY `ix_whatsapp_messages_session` (`session_id`, `created_at`),
  KEY `ix_whatsapp_messages_number` (`wa_number`, `created_at`),
  KEY `ix_whatsapp_messages_status` (`status`),
  CONSTRAINT `fk_whatsapp_messages_session`
    FOREIGN KEY (`session_id`) REFERENCES `whatsapp_sessions` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `whatsapp_flows` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `flow_key` VARCHAR(60) NOT NULL,
  `name` VARCHAR(160) NOT NULL,
  `description` VARCHAR(500) NULL,
  `definition` JSON NOT NULL COMMENT 'Ordered step definitions: prompt, input type, validation, next/prev',
  `version` INT UNSIGNED NOT NULL DEFAULT 1,
  `active` TINYINT(1) NOT NULL DEFAULT 1,
  `updated_by_user_id` INT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_whatsapp_flows_key` (`flow_key`),
  KEY `ix_whatsapp_flows_updated_by` (`updated_by_user_id`),
  CONSTRAINT `fk_whatsapp_flows_updated_by`
    FOREIGN KEY (`updated_by_user_id`) REFERENCES `users` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
