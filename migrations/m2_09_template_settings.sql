-- ----------------------------------------------------------------------------
-- Milestone 2 — approved WhatsApp template names.
--
-- Meta only allows free-form messages within 24 hours of the customer's last
-- message. Anything the business STARTS after that — "payment received", "your
-- certificate is ready", a reminder on an unpaid quote — must be a template
-- approved in WhatsApp Manager.
--
-- The names are settings rather than constants because Meta approval names
-- change, and a rename must not require a deploy.
--
-- SAFETY: INSERT IGNORE against the UNIQUE setting_key. Re-running changes
-- nothing and never overwrites a value the operator has saved.
-- ----------------------------------------------------------------------------
INSERT IGNORE INTO `app_settings` (`setting_key`, `setting_value`, `value_type`, `is_secret`, `description`) VALUES
  ('whatsapp.template_language',           'fr',  'string', 0, 'Locale code registered with the approved templates'),
  ('whatsapp.template_payment_received',   NULL,  'string', 0, 'Approved template sent when a payment is confirmed'),
  ('whatsapp.template_certificate_ready',  NULL,  'string', 0, 'Approved template sent when the certificate has been issued'),
  ('whatsapp.template_quote_reminder',     NULL,  'string', 0, 'Approved template used to follow up an unpaid quote');
