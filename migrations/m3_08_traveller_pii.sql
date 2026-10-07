-- ----------------------------------------------------------------------------
-- Milestone 3 — passport numbers encrypted at rest.
--
-- `travellers.passport_or_id` is plaintext, and a travel-insurance database of
-- passport numbers is the single most sensitive thing this platform holds. The
-- encryption machinery already exists (utils/appCrypto.js, AES-256-GCM) and
-- covered only the three WhatsApp secrets.
--
-- TWO COLUMNS, NOT ONE:
--
--   `passport_or_id_enc` holds the ciphertext.
--
--   `passport_or_id_hash` is an HMAC of the normalised value — a blind index.
--   Ciphertext is different every time (a fresh IV per write, which is what
--   makes it safe), so without this an exact lookup by passport number would be
--   impossible. The trade-off is explicit: exact match keeps working, partial
--   LIKE search over passport numbers does not. That is the right way round for
--   a field like this.
--
-- The plaintext column is LEFT IN PLACE by this migration. Dropping it here
-- would destroy data before anything had been encrypted; scripts/encryptPassports.js
-- backfills and clears it, with a dry run, under the operator's control.
--
-- SAFETY: additive only, guarded, re-runnable.
-- ----------------------------------------------------------------------------
SET @c := (SELECT COUNT(*) FROM information_schema.COLUMNS
           WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'travellers'
             AND COLUMN_NAME = 'passport_or_id_enc');
SET @s := IF(@c = 0,
  'ALTER TABLE `travellers` ADD COLUMN `passport_or_id_enc` TEXT NULL COMMENT ''AES-256-GCM ciphertext, v1.<iv>.<tag>.<ct>''',
  'DO 0');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @c := (SELECT COUNT(*) FROM information_schema.COLUMNS
           WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'travellers'
             AND COLUMN_NAME = 'passport_or_id_hash');
SET @s := IF(@c = 0,
  'ALTER TABLE `travellers` ADD COLUMN `passport_or_id_hash` CHAR(64) NULL COMMENT ''HMAC-SHA256 blind index for exact lookup''',
  'DO 0');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @i := (SELECT COUNT(*) FROM information_schema.STATISTICS
           WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'travellers'
             AND INDEX_NAME = 'ix_travellers_passport_hash');
SET @s := IF(@i = 0,
  'ALTER TABLE `travellers` ADD KEY `ix_travellers_passport_hash` (`passport_or_id_hash`)',
  'DO 0');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
