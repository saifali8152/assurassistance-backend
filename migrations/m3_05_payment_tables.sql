-- ----------------------------------------------------------------------------
-- Milestone 3 — payment transactions and their callback archive.
--
-- TWO TABLES, ON PURPOSE:
--
--   payment_transactions is the state machine. One row per attempt, with the
--   provider's own reference indexed UNIQUE so a retried callback can never
--   create a second transaction. `idempotency_key` is ours, generated per
--   attempt, so a customer tapping twice does not start two payments.
--
--   payment_callbacks is the archive, written BEFORE anything is processed and
--   never updated. It keeps the RAW bytes, not a normalised copy: in a dispute
--   the provider's exact payload and the signature header are the evidence, and
--   the WhatsApp module's lesson was that a parsed archive is not enough.
--
-- The transition rules live in code (utils/payments/stateMachine.js) rather
-- than in a CHECK constraint, so an illegal transition fails with a message
-- that names both states instead of a driver error. `status_history` records
-- every move for the audit trail the milestone asks for.
--
-- SAFETY: additive only. Two new tables; no existing table is altered.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `payment_transactions` (
  `id` BIGINT NOT NULL AUTO_INCREMENT,
  `reference` VARCHAR(60) NOT NULL COMMENT 'Our reference, shown to the customer',
  `case_id` INT NULL COMMENT 'The quote being paid for',
  `sale_id` INT NULL COMMENT 'Set once the policy is issued',
  `provider` VARCHAR(30) NOT NULL COMMENT 'orange | mtn | wave | moov | mock',
  `provider_tx_id` VARCHAR(190) NULL COMMENT 'The provider''s own id; UNIQUE so a replayed callback cannot duplicate',
  `idempotency_key` VARCHAR(190) NOT NULL COMMENT 'Ours, one per payment attempt',
  `msisdn` VARCHAR(32) NULL COMMENT 'Number charged; may differ from the WhatsApp number',
  `amount` DECIMAL(15,2) NOT NULL,
  `currency` VARCHAR(3) NOT NULL DEFAULT 'XOF',
  `status` ENUM('pending','initiated','awaiting_confirmation','completed','failed','expired','cancelled')
      NOT NULL DEFAULT 'pending',
  `failure_code` VARCHAR(60) NULL COMMENT 'Internal code, mapped from the provider''s',
  `failure_detail` VARCHAR(500) NULL,
  `status_history` JSON NULL COMMENT 'Append-only [{from,to,at,by,note}]',
  `wa_session_id` BIGINT NULL COMMENT 'Conversation to wake when this settles',
  `initiated_at` DATETIME NULL,
  `completed_at` DATETIME NULL,
  `expires_at` DATETIME NULL COMMENT 'When the sweeper may mark it expired',
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_payment_reference` (`reference`),
  UNIQUE KEY `uq_payment_idempotency` (`provider`, `idempotency_key`),
  UNIQUE KEY `uq_payment_provider_tx` (`provider`, `provider_tx_id`),
  KEY `ix_payment_status_expires` (`status`, `expires_at`),
  KEY `ix_payment_case` (`case_id`),
  KEY `ix_payment_sale` (`sale_id`),
  KEY `ix_payment_created` (`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `payment_callbacks` (
  `id` BIGINT NOT NULL AUTO_INCREMENT,
  `provider` VARCHAR(30) NOT NULL,
  `transaction_id` BIGINT NULL COMMENT 'Resolved after parsing; NULL when we could not match it',
  `provider_tx_id` VARCHAR(190) NULL,
  `signature_header` VARCHAR(255) NULL COMMENT 'As received, for dispute evidence',
  `signature_valid` TINYINT(1) NOT NULL DEFAULT 0,
  `raw_body` MEDIUMBLOB NOT NULL COMMENT 'Exact bytes, never a parsed copy',
  `content_type` VARCHAR(120) NULL,
  `remote_ip` VARCHAR(64) NULL,
  `processed` TINYINT(1) NOT NULL DEFAULT 0,
  `duplicate` TINYINT(1) NOT NULL DEFAULT 0 COMMENT 'Seen this provider_tx_id before',
  `process_error` VARCHAR(500) NULL,
  `received_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `ix_callbacks_tx` (`transaction_id`),
  KEY `ix_callbacks_provider_tx` (`provider`, `provider_tx_id`),
  KEY `ix_callbacks_received` (`received_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
