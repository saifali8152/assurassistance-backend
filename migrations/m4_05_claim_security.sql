-- ----------------------------------------------------------------------------
-- Milestone 4 — every claim validation attempt, for rate limiting and abuse
-- monitoring.
--
-- The existing per-number limiter lives in memory, allows 20 messages a minute
-- and resets on restart: right for flooding, useless against someone working
-- through passport numbers. Lockouts are computed from this table instead, so
-- they survive a restart and apply across workers.
--
-- Two directions of guessing are covered: one number trying many policies, and
-- many numbers trying one policy. `identifier_hash` is a keyed hash of the
-- policy or card number tried — the attempt log never holds the identifier
-- itself, and never holds the passport number in any form.
--
-- SAFETY: additive only. New table; no existing table is altered.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `claim_validation_attempts` (
  `id` BIGINT NOT NULL AUTO_INCREMENT,
  `wa_number` VARCHAR(32) NOT NULL,
  `session_id` BIGINT NULL,
  `identifier_hash` CHAR(64) NULL,
  `outcome` ENUM('success','not_found','mismatch','expired','cancelled','unpaid','out_of_window','not_started','no_dates','locked') NOT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `ix_validation_number` (`wa_number`, `created_at`),
  KEY `ix_validation_identifier` (`identifier_hash`, `created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
