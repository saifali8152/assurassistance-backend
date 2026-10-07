-- ----------------------------------------------------------------------------
-- Milestone 3 — one live policy per case, enforced by the database.
--
-- `sales.case_id` carried only a plain index, so one case could hold unlimited
-- sales. A partner retrying a timed-out POST issued a second policy with its
-- own certificate and invoice. The controller now checks first, but a check in
-- code is not a guarantee under concurrency, so the database enforces it too.
--
-- A VIRTUAL generated column is the mechanism, the same trick already used by
-- whatsapp_sessions.active_lock: it is the case id while the sale is live and
-- NULL once soft-deleted, and MySQL permits many NULLs in a UNIQUE index. So a
-- case may accumulate any number of cancelled sales but only ever one live one.
-- VIRTUAL rather than STORED so adding it does not rewrite the table.
--
-- SAFETY: additive only, and the index is added ONLY when the existing data
-- already satisfies it. If any case currently holds more than one live sale the
-- column is still added but the UNIQUE index is skipped, because creating it
-- would fail and abort the migration. @m3_dupes reports how many such cases
-- exist so they can be cleaned up and this migration re-run.
-- ----------------------------------------------------------------------------

-- Add the generated column if it is not already there.
SET @c := (SELECT COUNT(*) FROM information_schema.COLUMNS
           WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'sales'
             AND COLUMN_NAME = 'active_case_lock');
SET @s := IF(@c = 0,
  'ALTER TABLE `sales` ADD COLUMN `active_case_lock` INT GENERATED ALWAYS AS (IF(`deleted_at` IS NULL, `case_id`, NULL)) VIRTUAL COMMENT ''case_id while the sale is live, NULL once soft-deleted''',
  'DO 0');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- How many cases currently hold more than one live sale.
SET @m3_dupes := (SELECT COUNT(*) FROM (
  SELECT `case_id` FROM `sales` WHERE `deleted_at` IS NULL
   GROUP BY `case_id` HAVING COUNT(*) > 1
) d);

-- Add the UNIQUE index only when it can succeed.
SET @i := (SELECT COUNT(*) FROM information_schema.STATISTICS
           WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'sales'
             AND INDEX_NAME = 'uq_sales_active_case');
SET @s := IF(@i = 0 AND @m3_dupes = 0,
  'ALTER TABLE `sales` ADD UNIQUE KEY `uq_sales_active_case` (`active_case_lock`)',
  'DO 0');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SELECT @m3_dupes AS cases_with_more_than_one_live_sale,
       IF(@m3_dupes = 0, 'unique index in place', 'index skipped — clean up the duplicates and re-run') AS result;
