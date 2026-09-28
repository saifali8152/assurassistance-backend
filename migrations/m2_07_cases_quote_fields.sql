-- ----------------------------------------------------------------------------
-- Milestone 2 — quote fields on `cases`.
--
-- A WhatsApp conversation produces a QUOTE before any payment exists. The web
-- app already models a pre-sale record as a `cases` row with status 'Draft', so
-- we reuse it rather than inventing a parallel table: one case, one traveller,
-- one plan, one premium — and the existing sale/certificate/invoice chain then
-- works unchanged once payment lands in Milestone 3.
--
-- SAFETY NOTES ON THE ENUM CHANGE
--   'AwaitingPayment' is APPENDED to the end of the existing list. MySQL stores
--   ENUMs by ordinal position, so appending leaves every stored row byte-identical
--   — 'Draft' stays 1, 'Confirmed' 2, 'Cancelled' 3. The default and nullability
--   are restated exactly as they are today. The statement is skipped entirely if
--   the value is already present, so re-running is safe.
-- ----------------------------------------------------------------------------

-- quote_reference: customer-facing reference, e.g. QT-7F3A91C4.
SET @c := (SELECT COUNT(*) FROM information_schema.COLUMNS
           WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cases'
             AND COLUMN_NAME = 'quote_reference');
SET @s := IF(@c = 0,
  'ALTER TABLE `cases` ADD COLUMN `quote_reference` VARCHAR(50) NULL DEFAULT NULL AFTER `group_id`',
  'DO 0');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- UNIQUE, but nullable: every pre-existing case keeps NULL and MySQL allows
-- unlimited NULLs in a unique index, so no backfill is required.
SET @c := (SELECT COUNT(*) FROM information_schema.STATISTICS
           WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cases'
             AND INDEX_NAME = 'uq_cases_quote_reference');
SET @s := IF(@c = 0,
  'ALTER TABLE `cases` ADD UNIQUE KEY `uq_cases_quote_reference` (`quote_reference`)',
  'DO 0');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- source: distinguishes WhatsApp-originated business in the ledger and reports.
SET @c := (SELECT COUNT(*) FROM information_schema.COLUMNS
           WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cases'
             AND COLUMN_NAME = 'source');
SET @s := IF(@c = 0,
  'ALTER TABLE `cases` ADD COLUMN `source` ENUM(''web'',''whatsapp'',''api'') NOT NULL DEFAULT ''web'' AFTER `quote_reference`',
  'DO 0');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @c := (SELECT COUNT(*) FROM information_schema.STATISTICS
           WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cases'
             AND INDEX_NAME = 'ix_cases_source');
SET @s := IF(@c = 0,
  'ALTER TABLE `cases` ADD KEY `ix_cases_source` (`source`)',
  'DO 0');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- Append 'AwaitingPayment' to the status ENUM (see safety note above).
SET @c := (SELECT COUNT(*) FROM information_schema.COLUMNS
           WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cases'
             AND COLUMN_NAME = 'status' AND COLUMN_TYPE LIKE '%AwaitingPayment%');
SET @s := IF(@c = 0,
  'ALTER TABLE `cases` MODIFY COLUMN `status` ENUM(''Draft'',''Confirmed'',''Cancelled'',''AwaitingPayment'') NULL DEFAULT ''Draft''',
  'DO 0');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
