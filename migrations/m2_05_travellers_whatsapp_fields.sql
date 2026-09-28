-- ----------------------------------------------------------------------------
-- Milestone 2 — WhatsApp fields on `travellers`.
--
-- SAFETY: every statement is guarded against information_schema, so this file
-- can be re-run on the live database without error and without touching a
-- single existing row. Nothing is dropped, nothing is narrowed, no defaults on
-- existing columns change. New columns are nullable or carry a default that
-- matches current behaviour ('web'), so historical travellers stay correct.
-- ----------------------------------------------------------------------------

-- whatsapp_number: the number the customer wrote from (E.164, no + prefix).
SET @c := (SELECT COUNT(*) FROM information_schema.COLUMNS
           WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'travellers'
             AND COLUMN_NAME = 'whatsapp_number');
SET @s := IF(@c = 0,
  'ALTER TABLE `travellers` ADD COLUMN `whatsapp_number` VARCHAR(32) NULL DEFAULT NULL AFTER `phone`',
  'DO 0');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @c := (SELECT COUNT(*) FROM information_schema.STATISTICS
           WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'travellers'
             AND INDEX_NAME = 'ix_travellers_whatsapp_number');
SET @s := IF(@c = 0,
  'ALTER TABLE `travellers` ADD KEY `ix_travellers_whatsapp_number` (`whatsapp_number`)',
  'DO 0');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- source: where the traveller record came from. Existing rows were all created
-- through the web app, and 'web' is the default, so no backfill is needed.
SET @c := (SELECT COUNT(*) FROM information_schema.COLUMNS
           WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'travellers'
             AND COLUMN_NAME = 'source');
SET @s := IF(@c = 0,
  'ALTER TABLE `travellers` ADD COLUMN `source` ENUM(''web'',''whatsapp'',''api'') NOT NULL DEFAULT ''web'' AFTER `whatsapp_number`',
  'DO 0');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- preferred_language: remembered so a returning customer is greeted correctly.
SET @c := (SELECT COUNT(*) FROM information_schema.COLUMNS
           WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'travellers'
             AND COLUMN_NAME = 'preferred_language');
SET @s := IF(@c = 0,
  'ALTER TABLE `travellers` ADD COLUMN `preferred_language` ENUM(''fr'',''en'') NULL DEFAULT NULL AFTER `source`',
  'DO 0');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
