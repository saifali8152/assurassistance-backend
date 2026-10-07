-- ----------------------------------------------------------------------------
-- Milestone 3 — request idempotency.
--
-- A partner retrying a timed-out POST /api/sales issued a second policy, and a
-- payment provider retrying a callback would do the same. An Idempotency-Key
-- header now makes a retry return the first response instead of repeating the
-- work.
--
-- The UNIQUE key is the guard: two concurrent requests with the same key race
-- to INSERT, exactly one wins, and the loser waits for the winner's recorded
-- response rather than executing.
--
-- `request_fingerprint` catches a client reusing one key for a different body,
-- which is a client bug worth reporting rather than silently serving the wrong
-- cached response.
--
-- SAFETY: additive only. New table; no existing table is altered.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `idempotency_keys` (
  `id` BIGINT NOT NULL AUTO_INCREMENT,
  `idempotency_key` VARCHAR(255) NOT NULL,
  `scope` VARCHAR(80) NOT NULL COMMENT 'Route identity, e.g. sales:create',
  `request_fingerprint` CHAR(64) NOT NULL COMMENT 'SHA-256 of the canonical request body',
  `status` ENUM('in_progress','completed','failed') NOT NULL DEFAULT 'in_progress',
  `response_status` INT NULL,
  `response_body` JSON NULL,
  `actor_user_id` INT NULL,
  `api_key_id` INT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `completed_at` DATETIME NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_idempotency_scope_key` (`scope`, `idempotency_key`),
  KEY `ix_idempotency_created` (`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
