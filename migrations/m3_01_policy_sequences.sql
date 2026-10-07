-- ----------------------------------------------------------------------------
-- Milestone 3 — atomic document numbering.
--
-- Policy, invoice and certificate numbers were minted as `POL-${Date.now()}`
-- against UNIQUE columns with no retry. Two confirmations inside the same
-- millisecond collided and surfaced as an unhandled 500 with the first row
-- possibly already written. Concurrent mobile-money payments make that normal
-- rather than theoretical, so numbering moves to a real sequence.
--
-- Allocation is a single statement:
--   INSERT ... ON DUPLICATE KEY UPDATE current_value = LAST_INSERT_ID(current_value + 1)
-- which takes a row lock and returns the allocated value through LAST_INSERT_ID().
-- It must run on the same connection as the SELECT that reads it back, which is
-- why utils/documentNumbers.js takes a connection rather than the pool.
--
-- `period` lets a format restart its count each year or month. A format with no
-- date token uses the literal 'ALL' so one row serves forever.
--
-- SAFETY: additive only. New table plus INSERT IGNORE seeds; no existing table
-- is altered and no row is updated.
-- ----------------------------------------------------------------------------
-- NOTE: no AUTO_INCREMENT column, deliberately. When an INSERT generates an
-- auto-increment id, MySQL overwrites the session's LAST_INSERT_ID with that
-- id, so the first allocation would return the row's primary key instead of 1.
-- (Found by the integration test: it returned 33.) With the natural key as the
-- primary key, LAST_INSERT_ID(expr) is the only thing setting that value.
CREATE TABLE IF NOT EXISTS `policy_sequences` (
  `seq_key` VARCHAR(40) NOT NULL COMMENT 'policy | invoice | certificate',
  `period` VARCHAR(10) NOT NULL DEFAULT 'ALL' COMMENT 'ALL, 2026, or 2026-10',
  `current_value` BIGINT UNSIGNED NOT NULL DEFAULT 0,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`seq_key`, `period`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Number formats are operator-settable because the insurer's prefix and any
-- regulatory sequence rule are theirs to decide, and a rename must not need a
-- deploy. Tokens: {YYYY} {YY} {MM} {SEQ:n}. A format with no date token counts
-- forever; one with {YYYY} or {MM} restarts each period.
INSERT IGNORE INTO `app_settings` (`setting_key`, `setting_value`, `value_type`, `is_secret`, `description`) VALUES
  ('policy.number_format',      'AA-{YYYY}-{SEQ:6}',   'string', 0, 'Policy number format. Tokens: {YYYY} {YY} {MM} {SEQ:n}'),
  ('policy.invoice_format',     'INV-{YYYY}-{SEQ:6}',  'string', 0, 'Invoice number format, same tokens'),
  ('policy.certificate_format', 'CERT-{YYYY}-{SEQ:6}', 'string', 0, 'Certificate number format, same tokens');
