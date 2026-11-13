-- ----------------------------------------------------------------------------
-- Milestone 4 — the outbox for new-claim notifications.
--
-- The existing alert mailer throttles and de-duplicates on purpose: right for
-- "the database is down", wrong for "a claim was filed", where every single one
-- must reach the claims team. A row is written in the same transaction as the
-- claim, and scripts/sendClaimNotifications.js delivers it with retries — so a
-- mail server being down delays a notification but can never lose it, and never
-- blocks the claim itself.
--
-- Recipients are resolved at send time, not stored at enqueue, so changing the
-- address in the admin panel also redirects anything still waiting. `sent_to`
-- records where it actually went.
--
-- SAFETY: additive only. New table; no existing table is altered.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `claim_notifications` (
  `id` BIGINT NOT NULL AUTO_INCREMENT,
  `claim_id` BIGINT NOT NULL,
  `channel` ENUM('email') NOT NULL DEFAULT 'email',
  `priority` ENUM('normal','high','urgent') NOT NULL DEFAULT 'normal',
  `status` ENUM('pending','sent','failed','skipped') NOT NULL DEFAULT 'pending',
  `attempts` SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  `next_attempt_at` DATETIME NULL,
  `last_error` VARCHAR(500) NULL,
  `sent_to` VARCHAR(500) NULL,
  `sent_at` DATETIME NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_claim_notification` (`claim_id`, `channel`),
  KEY `ix_claim_notification_due` (`status`, `next_attempt_at`),
  CONSTRAINT `fk_claim_notifications_claim` FOREIGN KEY (`claim_id`) REFERENCES `claims` (`id`) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
