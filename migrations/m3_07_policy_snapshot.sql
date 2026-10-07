-- ----------------------------------------------------------------------------
-- Milestone 3 — record what was actually issued, and when money arrived.
--
-- TWO PROBLEMS THIS CLOSES.
--
-- 1. Certificates were re-rendered from the LIVE catalogue every time, by
--    design: "prefer live plan pricing so catalogue edits flow through". That
--    is right for a draft and wrong for a paid policy. An insurer who corrects
--    a premium or reworded a benefit would change the document a travelling
--    customer already holds, and the two copies would disagree with no record
--    of which was issued. `issued_snapshot` freezes the figures and wording at
--    issuance; the renderer prefers it when present.
--
-- 2. `payment_notes` was the only trace of how and when money arrived, and the
--    timing was recoverable only from the activity log. Mobile money needs
--    better: a settlement report has to join on a provider reference and a
--    timestamp.
--
-- SAFETY: additive only, guarded by information_schema, so it is re-runnable
-- and touches no existing row.
-- ----------------------------------------------------------------------------

-- certificates.issued_snapshot
SET @c := (SELECT COUNT(*) FROM information_schema.COLUMNS
           WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'certificates'
             AND COLUMN_NAME = 'issued_snapshot');
SET @s := IF(@c = 0,
  'ALTER TABLE `certificates` ADD COLUMN `issued_snapshot` JSON NULL COMMENT ''Frozen copy of what the certificate said when issued''',
  'DO 0');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- sales.paid_at
SET @c := (SELECT COUNT(*) FROM information_schema.COLUMNS
           WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'sales'
             AND COLUMN_NAME = 'paid_at');
SET @s := IF(@c = 0,
  'ALTER TABLE `sales` ADD COLUMN `paid_at` DATETIME NULL COMMENT ''When the payment was confirmed''',
  'DO 0');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- sales.payment_method
SET @c := (SELECT COUNT(*) FROM information_schema.COLUMNS
           WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'sales'
             AND COLUMN_NAME = 'payment_method');
SET @s := IF(@c = 0,
  'ALTER TABLE `sales` ADD COLUMN `payment_method` VARCHAR(40) NULL COMMENT ''cash | transfer | orange | mtn | wave | moov''',
  'DO 0');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- sales.payment_reference — the provider's reference, for settlement matching
SET @c := (SELECT COUNT(*) FROM information_schema.COLUMNS
           WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'sales'
             AND COLUMN_NAME = 'payment_reference');
SET @s := IF(@c = 0,
  'ALTER TABLE `sales` ADD COLUMN `payment_reference` VARCHAR(60) NULL COMMENT ''Payment transaction reference, e.g. PAY-2026-000012''',
  'DO 0');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @i := (SELECT COUNT(*) FROM information_schema.STATISTICS
           WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'sales'
             AND INDEX_NAME = 'ix_sales_payment_reference');
SET @s := IF(@i = 0,
  'ALTER TABLE `sales` ADD KEY `ix_sales_payment_reference` (`payment_reference`)',
  'DO 0');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
