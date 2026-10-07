-- ----------------------------------------------------------------------------
-- Milestone 3 — link a conversation to the payment it is waiting on.
--
-- WHY NOT A NEW SESSION STATUS: the plan called for an `awaiting_payment` value
-- on whatsapp_sessions.status. That would have broken the `active_lock`
-- generated column, which is `IF(status = 'active', wa_number, NULL)` and backs
-- the UNIQUE index enforcing one live conversation per number. A session in
-- `awaiting_payment` would drop out of that index, and a customer who sent
-- "have you got my payment?" while waiting would have started a SECOND
-- conversation on the same number.
--
-- A session waiting for a payment is still active — it is parked on a step, not
-- finished — so the waiting is expressed by `current_step = 'payment_wait'` plus
-- this column, and the status ENUM is left alone. Changing the generated column
-- instead would have meant dropping and recreating it and its unique index on a
-- live table.
--
-- SAFETY: additive only, guarded by information_schema so it is re-runnable.
-- ----------------------------------------------------------------------------
SET @c := (SELECT COUNT(*) FROM information_schema.COLUMNS
           WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'whatsapp_sessions'
             AND COLUMN_NAME = 'payment_transaction_id');
SET @s := IF(@c = 0,
  'ALTER TABLE `whatsapp_sessions` ADD COLUMN `payment_transaction_id` BIGINT NULL COMMENT ''The payment this conversation is parked on''',
  'DO 0');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @i := (SELECT COUNT(*) FROM information_schema.STATISTICS
           WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'whatsapp_sessions'
             AND INDEX_NAME = 'ix_sessions_payment_tx');
SET @s := IF(@i = 0,
  'ALTER TABLE `whatsapp_sessions` ADD KEY `ix_sessions_payment_tx` (`payment_transaction_id`)',
  'DO 0');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
