-- ----------------------------------------------------------------------------
-- Milestone 4 — link a conversation to the claim it is building.
--
--   claim_id         the draft or submitted claim this session is working on
--   parked_purchase  a purchase the customer was in the middle of when they
--                    asked to file a claim, kept so it can be offered back
--                    afterwards instead of being lost
--
-- Which journey a session is on is already recorded: `flow_key` ('purchase' or
-- 'claim'). The status ENUM is deliberately left alone, for the reason given in
-- m3_06: the one-active-session-per-number index is built on it.
--
-- This is the only live table Milestone 4 alters. Both columns are nullable and
-- added at the end, which MySQL 8 and MariaDB 10.3+ do instantly without
-- rebuilding the table; existing rows read NULL and nothing that already uses
-- the table selects them.
--
-- SAFETY: additive only, guarded by information_schema so it is re-runnable.
-- ----------------------------------------------------------------------------
SET @c := (SELECT COUNT(*) FROM information_schema.COLUMNS
           WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'whatsapp_sessions'
             AND COLUMN_NAME = 'claim_id');
SET @s := IF(@c = 0,
  'ALTER TABLE `whatsapp_sessions` ADD COLUMN `claim_id` BIGINT NULL COMMENT ''The claim this conversation is building''',
  'DO 0');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @c := (SELECT COUNT(*) FROM information_schema.COLUMNS
           WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'whatsapp_sessions'
             AND COLUMN_NAME = 'parked_purchase');
SET @s := IF(@c = 0,
  'ALTER TABLE `whatsapp_sessions` ADD COLUMN `parked_purchase` JSON NULL COMMENT ''A purchase set aside while a claim is filed''',
  'DO 0');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @i := (SELECT COUNT(*) FROM information_schema.STATISTICS
           WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'whatsapp_sessions'
             AND INDEX_NAME = 'ix_sessions_claim');
SET @s := IF(@i = 0,
  'ALTER TABLE `whatsapp_sessions` ADD KEY `ix_sessions_claim` (`claim_id`)',
  'DO 0');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
