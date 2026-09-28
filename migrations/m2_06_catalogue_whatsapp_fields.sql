-- ----------------------------------------------------------------------------
-- Milestone 2 — WhatsApp fields on `catalogue`.
--
-- `catalogue.coverage` holds long, web-formatted copy that does not fit inside a
-- WhatsApp message. These two new columns hold a short quote-ready summary per
-- language. `whatsapp_enabled` lets the superadmin choose which plans are
-- sellable over chat — it defaults to 0, so enabling the module does not
-- silently expose every existing plan.
--
-- SAFETY: guarded, additive, nullable. Existing plan data is untouched.
-- ----------------------------------------------------------------------------

SET @c := (SELECT COUNT(*) FROM information_schema.COLUMNS
           WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'catalogue'
             AND COLUMN_NAME = 'coverage_summary_fr');
SET @s := IF(@c = 0,
  'ALTER TABLE `catalogue` ADD COLUMN `coverage_summary_fr` TEXT NULL DEFAULT NULL AFTER `coverage`',
  'DO 0');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @c := (SELECT COUNT(*) FROM information_schema.COLUMNS
           WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'catalogue'
             AND COLUMN_NAME = 'coverage_summary_en');
SET @s := IF(@c = 0,
  'ALTER TABLE `catalogue` ADD COLUMN `coverage_summary_en` TEXT NULL DEFAULT NULL AFTER `coverage_summary_fr`',
  'DO 0');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @c := (SELECT COUNT(*) FROM information_schema.COLUMNS
           WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'catalogue'
             AND COLUMN_NAME = 'whatsapp_enabled');
SET @s := IF(@c = 0,
  'ALTER TABLE `catalogue` ADD COLUMN `whatsapp_enabled` TINYINT(1) NOT NULL DEFAULT 0 AFTER `active`',
  'DO 0');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @c := (SELECT COUNT(*) FROM information_schema.STATISTICS
           WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'catalogue'
             AND INDEX_NAME = 'ix_catalogue_whatsapp_enabled');
SET @s := IF(@c = 0,
  'ALTER TABLE `catalogue` ADD KEY `ix_catalogue_whatsapp_enabled` (`whatsapp_enabled`, `active`)',
  'DO 0');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
