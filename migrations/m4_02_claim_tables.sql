-- ----------------------------------------------------------------------------
-- Milestone 4 — claims, their documents and their status history.
--
-- WHY THERE ARE NO FOREIGN KEYS TO `sales`: a claim points at a live policy, but
-- adding a foreign key to `sales` would take a metadata lock on a table that is
-- serving paying customers, and would tie this module's integrity to theirs.
-- The claims module only ever READS `sales`; the reference is an indexed column.
-- Foreign keys exist only between the new tables, where they cost nothing.
--
-- `reference` is NULL while a claim is a draft and is allocated at submission,
-- so abandoned drafts never consume case numbers. UNIQUE allows many NULLs.
--
-- `abandoned` is a terminal status the client plan did not list: without it a
-- draft that is never submitted would sit in `draft` forever. Drafts are marked,
-- never deleted.
--
-- SAFETY: additive only. New tables; no existing table is altered.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `claims` (
  `id` BIGINT NOT NULL AUTO_INCREMENT,
  `reference` VARCHAR(40) NULL COMMENT 'Case number, allocated at submission',
  `status` ENUM('draft','submitted','under_review','closed','abandoned') NOT NULL DEFAULT 'draft',
  `priority` ENUM('normal','high','urgent') NOT NULL DEFAULT 'normal',
  `sale_id` INT NULL COMMENT 'Policy issued on this platform (read-only reference)',
  `external_policy_id` BIGINT NULL COMMENT 'Or an imported policy',
  `policy_number` VARCHAR(60) NULL COMMENT 'Denormalised for search',
  `holder_name` VARCHAR(255) NULL COMMENT 'Denormalised for the claims list',
  `wa_number` VARCHAR(32) NOT NULL COMMENT 'Number that filed it — ownership for status lookups',
  `session_id` BIGINT NULL,
  `language` ENUM('fr','en') NOT NULL DEFAULT 'fr',
  `category_code` VARCHAR(60) NULL,
  `subcategory_code` VARCHAR(60) NULL,
  `incident_date` DATE NULL,
  `incident_country_code` CHAR(2) NULL,
  `incident_country` VARCHAR(120) NULL,
  `incident_city` VARCHAR(120) NULL,
  `description` TEXT NULL,
  `extra_fields` JSON NULL COMMENT 'Sub-category specific answers',
  `flags` JSON NULL COMMENT 'e.g. unpaid_policy, guarantee_not_on_plan, urgent_keyword',
  `policy_snapshot` JSON NULL COMMENT 'The policy as it stood at submission',
  `is_test` TINYINT(1) NOT NULL DEFAULT 0 COMMENT 'Filed from an allowlisted number or the simulator',
  `consent_accepted_at` DATETIME NULL,
  `submitted_at` DATETIME NULL,
  `closed_at` DATETIME NULL,
  `abandoned_at` DATETIME NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_claims_reference` (`reference`),
  KEY `ix_claims_sale` (`sale_id`),
  KEY `ix_claims_external_policy` (`external_policy_id`),
  KEY `ix_claims_policy_number` (`policy_number`),
  KEY `ix_claims_wa_number` (`wa_number`, `created_at`),
  KEY `ix_claims_status` (`status`, `created_at`),
  KEY `ix_claims_priority` (`priority`, `status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `claim_documents` (
  `id` BIGINT NOT NULL AUTO_INCREMENT,
  `claim_id` BIGINT NOT NULL,
  `storage_key` VARCHAR(80) NULL COMMENT 'Random file name under storage/claims; NULL until stored',
  `original_filename` VARCHAR(255) NULL,
  `declared_mime` VARCHAR(120) NULL COMMENT 'What Meta said it was',
  `detected_mime` VARCHAR(60) NULL COMMENT 'What its first bytes say it is',
  `size_bytes` INT UNSIGNED NULL,
  `sha256` CHAR(64) NULL COMMENT 'Of the original file, before encryption',
  `document_type` VARCHAR(60) NULL COMMENT 'Which requested document this is, when known',
  `media_id` VARCHAR(128) NULL COMMENT 'Meta media id — what a re-fetch uses',
  `wa_message_id` VARCHAR(128) NULL COMMENT 'Meta message id — stops a redelivered webhook attaching a file twice',
  `status` ENUM('pending','stored','failed','rejected','purged') NOT NULL DEFAULT 'pending',
  `failure_code` VARCHAR(60) NULL,
  `attempts` SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  `next_attempt_at` DATETIME NULL,
  `stored_at` DATETIME NULL,
  `purged_at` DATETIME NULL COMMENT 'File removed under the retention policy; the row stays',
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_claim_documents_storage_key` (`storage_key`),
  UNIQUE KEY `uq_claim_documents_message` (`wa_message_id`),
  KEY `ix_claim_documents_claim` (`claim_id`),
  KEY `ix_claim_documents_retry` (`status`, `next_attempt_at`),
  CONSTRAINT `fk_claim_documents_claim` FOREIGN KEY (`claim_id`) REFERENCES `claims` (`id`) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `claim_status_history` (
  `id` BIGINT NOT NULL AUTO_INCREMENT,
  `claim_id` BIGINT NOT NULL,
  `from_status` VARCHAR(20) NULL,
  `to_status` VARCHAR(20) NOT NULL,
  `changed_by_user_id` INT NULL,
  `changed_by` VARCHAR(60) NULL COMMENT 'customer | system | user — who, when there is no user id',
  `note` VARCHAR(500) NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `ix_claim_history_claim` (`claim_id`, `created_at`),
  CONSTRAINT `fk_claim_history_claim` FOREIGN KEY (`claim_id`) REFERENCES `claims` (`id`) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
