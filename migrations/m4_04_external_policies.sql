-- ----------------------------------------------------------------------------
-- Milestone 4 — policies sold outside this platform.
--
-- Added one at a time or imported from a spreadsheet in the admin panel, so a
-- customer who bought elsewhere can still file a claim.
--
-- THESE ARE NOT SALES. They exist only so a claim can be validated. They never
-- appear in `sales`, so they never reach the ledger, commissions, partner
-- invoices or revenue — money that did not pass through the platform must not
-- be counted as if it had. Test policies for production testing go in here too,
-- marked `is_test`, for the same reason.
--
-- Passport numbers follow the M3 rule: AES-256-GCM ciphertext plus a keyed
-- blind index for exact lookup. No plaintext column exists on this table at all.
--
-- `card_number` is the assistance card number when the client runs separate
-- cards (claims.card_number_mode = 'separate').
--
-- SAFETY: additive only. New table; no existing table is altered.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `external_policies` (
  `id` BIGINT NOT NULL AUTO_INCREMENT,
  `policy_number` VARCHAR(60) NOT NULL,
  `card_number` VARCHAR(60) NULL,
  `holder_first_name` VARCHAR(255) NULL,
  `holder_last_name` VARCHAR(255) NULL,
  `date_of_birth` DATE NULL,
  `passport_or_id_enc` TEXT NULL COMMENT 'AES-256-GCM, v1.<iv>.<tag>.<ct>',
  `passport_or_id_hash` CHAR(64) NULL COMMENT 'HMAC-SHA256 blind index',
  `phone` VARCHAR(50) NULL,
  `product_name` VARCHAR(160) NULL,
  `insurer` VARCHAR(120) NULL,
  `destination` TEXT NULL,
  `start_date` DATE NOT NULL,
  `end_date` DATE NOT NULL,
  `status` ENUM('active','cancelled') NOT NULL DEFAULT 'active',
  `payment_status` ENUM('paid','unpaid','unknown') NOT NULL DEFAULT 'unknown',
  `guarantee_codes` JSON NULL COMMENT 'What the policy covers, when known',
  `is_test` TINYINT(1) NOT NULL DEFAULT 0,
  `source` ENUM('manual','import') NOT NULL DEFAULT 'manual',
  `import_batch_id` VARCHAR(40) NULL,
  `created_by_user_id` INT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_external_policy_number` (`policy_number`),
  UNIQUE KEY `uq_external_card_number` (`card_number`),
  KEY `ix_external_passport_hash` (`passport_or_id_hash`),
  KEY `ix_external_batch` (`import_batch_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
