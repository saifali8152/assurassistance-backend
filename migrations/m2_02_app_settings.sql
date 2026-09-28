-- ----------------------------------------------------------------------------
-- Milestone 2 — superadmin-managed application settings.
--
-- Replaces .env for operator-configurable values. The WhatsApp integration is
-- the first consumer, but the table is deliberately generic so future modules
-- reuse it instead of adding more environment variables.
--
-- Secrets (`is_secret = 1`) are stored as AES-256-GCM ciphertext produced by
-- utils/appCrypto.js. The master key lives in SETTINGS_ENCRYPTION_KEY and never
-- in the database. Secret values are never returned to the UI in clear text.
--
-- SAFETY: additive only. New table; no existing table is altered.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `app_settings` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `setting_key` VARCHAR(120) NOT NULL COMMENT 'Namespaced, e.g. whatsapp.access_token',
  `setting_value` TEXT NULL COMMENT 'Plaintext, or AES-256-GCM ciphertext when is_secret = 1',
  `value_type` ENUM('string','number','boolean','json') NOT NULL DEFAULT 'string',
  `is_secret` TINYINT(1) NOT NULL DEFAULT 0,
  `description` VARCHAR(500) NULL,
  `updated_by_user_id` INT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_app_settings_key` (`setting_key`),
  KEY `ix_app_settings_updated_by` (`updated_by_user_id`),
  CONSTRAINT `fk_app_settings_updated_by`
    FOREIGN KEY (`updated_by_user_id`) REFERENCES `users` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Register the WhatsApp keys with their descriptions. INSERT IGNORE so an
-- operator's saved value is never overwritten by re-running this migration.
INSERT IGNORE INTO `app_settings` (`setting_key`, `setting_value`, `value_type`, `is_secret`, `description`) VALUES
  ('whatsapp.enabled',               '0',    'boolean', 0, 'Master switch for the WhatsApp purchase flow'),
  ('whatsapp.phone_number_id',       NULL,   'string',  0, 'Meta WhatsApp phone number ID'),
  ('whatsapp.waba_id',               NULL,   'string',  0, 'WhatsApp Business Account ID'),
  ('whatsapp.business_number',       NULL,   'string',  0, 'Display number, e.g. +225 07 18 92 31 94'),
  ('whatsapp.api_version',           'v21.0','string',  0, 'Meta Graph API version'),
  ('whatsapp.access_token',          NULL,   'string',  1, 'Permanent system-user access token'),
  ('whatsapp.app_secret',            NULL,   'string',  1, 'Meta app secret, used for X-Hub-Signature-256'),
  ('whatsapp.verify_token',          NULL,   'string',  1, 'Webhook verification token configured in Meta'),
  ('whatsapp.default_language',      'fr',   'string',  0, 'Default conversation language (fr or en)'),
  ('whatsapp.session_timeout_hours', '24',   'number',  0, 'Inactivity window before a session expires'),
  ('whatsapp.message_retention_days','180',  'number',  0, 'How long inbound/outbound transcripts are kept'),
  ('whatsapp.escalation_number',     NULL,   'string',  0, 'Number shown when a customer asks for a human agent'),
  ('whatsapp.attribution_user_id',   NULL,   'number',  0, 'User account that owns WhatsApp-originated sales'),
  ('whatsapp.max_field_retries',     '3',    'number',  0, 'Retries per field before falling back to simple prompts');
