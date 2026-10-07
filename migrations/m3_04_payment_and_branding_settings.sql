-- ----------------------------------------------------------------------------
-- Milestone 3 — everything the client supplies, as settings.
--
-- Provider credentials, company identity and certificate wording all belong to
-- the insurer and all change without a deploy, so none of them live in .env.
-- The twelve secret rows (API keys, subscription keys, callback secrets) are
-- AES-256-GCM encrypted by utils/appCrypto.js before they are written, and the
-- admin screen only ever shows a mask.
--
-- The rows below mirror SETTING_REGISTRY in models/settingsModel.js, which is
-- what actually governs reads and writes — a key registered here but not there
-- cannot be written through the API, and this file was generated from it.
--
-- SAFETY: INSERT IGNORE against the UNIQUE setting_key. Re-running changes
-- nothing and never overwrites a value the operator has saved.
-- ----------------------------------------------------------------------------
INSERT IGNORE INTO `app_settings` (`setting_key`, `setting_value`, `value_type`, `is_secret`, `description`) VALUES
  ('company.legal_name', NULL, 'string', 0, 'Legal name exactly as registered'),
  ('company.address', NULL, 'string', 0, 'Registered address, one line'),
  ('company.phone', NULL, 'string', 0, 'Contact number printed on documents'),
  ('company.email', NULL, 'string', 0, 'Contact email printed on documents'),
  ('company.website', NULL, 'string', 0, 'Website printed on documents'),
  ('certificate.footer_fr', NULL, 'string', 0, 'Footer line on the French certificate'),
  ('certificate.footer_en', NULL, 'string', 0, 'Footer line on the English certificate'),
  ('certificate.terms_fr', NULL, 'string', 0, 'Policy terms paragraph, French'),
  ('certificate.terms_en', NULL, 'string', 0, 'Policy terms paragraph, English'),
  ('certificate.signature_name', NULL, 'string', 0, 'Name printed in the signature block'),
  ('certificate.signature_title', NULL, 'string', 0, 'Title printed under the signature'),
  ('payment.enabled', '0', 'boolean', 0, 'Master switch for in-conversation payment'),
  ('payment.currency', 'XOF', 'string', 0, 'Currency charged at the provider'),
  ('payment.timeout_minutes', '15', 'number', 0, 'How long a pending payment waits before it is marked expired'),
  ('payment.countries', NULL, 'string', 0, 'ISO country codes the payment step is offered in, comma separated'),
  ('payment.settlement_note', NULL, 'string', 0, 'Free note on where funds settle, for the operator''s own reference'),
  ('payment.orange.enabled', '0', 'boolean', 0, 'Orange Money — Offer this provider to customers'),
  ('payment.orange.label', NULL, 'string', 0, 'Orange Money — Name shown to the customer in the chat'),
  ('payment.orange.countries', NULL, 'string', 0, 'Orange Money — ISO country codes this provider covers, comma separated'),
  ('payment.orange.msisdn_prefixes', NULL, 'string', 0, 'Orange Money — Valid number prefixes, comma separated, e.g. 07,08'),
  ('payment.orange.base_url', NULL, 'string', 0, 'Orange Money — API base URL for the chosen environment'),
  ('payment.orange.merchant_id', NULL, 'string', 0, 'Orange Money — Merchant or collection account identifier'),
  ('payment.orange.api_user', NULL, 'string', 0, 'Orange Money — API user / client id issued by the provider'),
  ('payment.orange.api_key', NULL, 'string', 1, 'Orange Money — API key / client secret'),
  ('payment.orange.subscription_key', NULL, 'string', 1, 'Orange Money — Subscription key, where the provider issues one'),
  ('payment.orange.callback_secret', NULL, 'string', 1, 'Orange Money — Shared secret used to verify callback signatures'),
  ('payment.orange.settlement_account', NULL, 'string', 0, 'Orange Money — Account funds settle into, for reconciliation'),
  ('payment.mtn.enabled', '0', 'boolean', 0, 'MTN MoMo — Offer this provider to customers'),
  ('payment.mtn.label', NULL, 'string', 0, 'MTN MoMo — Name shown to the customer in the chat'),
  ('payment.mtn.countries', NULL, 'string', 0, 'MTN MoMo — ISO country codes this provider covers, comma separated'),
  ('payment.mtn.msisdn_prefixes', NULL, 'string', 0, 'MTN MoMo — Valid number prefixes, comma separated, e.g. 07,08'),
  ('payment.mtn.base_url', NULL, 'string', 0, 'MTN MoMo — API base URL for the chosen environment'),
  ('payment.mtn.merchant_id', NULL, 'string', 0, 'MTN MoMo — Merchant or collection account identifier'),
  ('payment.mtn.api_user', NULL, 'string', 0, 'MTN MoMo — API user / client id issued by the provider'),
  ('payment.mtn.api_key', NULL, 'string', 1, 'MTN MoMo — API key / client secret'),
  ('payment.mtn.subscription_key', NULL, 'string', 1, 'MTN MoMo — Subscription key, where the provider issues one'),
  ('payment.mtn.callback_secret', NULL, 'string', 1, 'MTN MoMo — Shared secret used to verify callback signatures'),
  ('payment.mtn.settlement_account', NULL, 'string', 0, 'MTN MoMo — Account funds settle into, for reconciliation'),
  ('payment.wave.enabled', '0', 'boolean', 0, 'Wave — Offer this provider to customers'),
  ('payment.wave.label', NULL, 'string', 0, 'Wave — Name shown to the customer in the chat'),
  ('payment.wave.countries', NULL, 'string', 0, 'Wave — ISO country codes this provider covers, comma separated'),
  ('payment.wave.msisdn_prefixes', NULL, 'string', 0, 'Wave — Valid number prefixes, comma separated, e.g. 07,08'),
  ('payment.wave.base_url', NULL, 'string', 0, 'Wave — API base URL for the chosen environment'),
  ('payment.wave.merchant_id', NULL, 'string', 0, 'Wave — Merchant or collection account identifier'),
  ('payment.wave.api_user', NULL, 'string', 0, 'Wave — API user / client id issued by the provider'),
  ('payment.wave.api_key', NULL, 'string', 1, 'Wave — API key / client secret'),
  ('payment.wave.subscription_key', NULL, 'string', 1, 'Wave — Subscription key, where the provider issues one'),
  ('payment.wave.callback_secret', NULL, 'string', 1, 'Wave — Shared secret used to verify callback signatures'),
  ('payment.wave.settlement_account', NULL, 'string', 0, 'Wave — Account funds settle into, for reconciliation'),
  ('payment.moov.enabled', '0', 'boolean', 0, 'Moov Money — Offer this provider to customers'),
  ('payment.moov.label', NULL, 'string', 0, 'Moov Money — Name shown to the customer in the chat'),
  ('payment.moov.countries', NULL, 'string', 0, 'Moov Money — ISO country codes this provider covers, comma separated'),
  ('payment.moov.msisdn_prefixes', NULL, 'string', 0, 'Moov Money — Valid number prefixes, comma separated, e.g. 07,08'),
  ('payment.moov.base_url', NULL, 'string', 0, 'Moov Money — API base URL for the chosen environment'),
  ('payment.moov.merchant_id', NULL, 'string', 0, 'Moov Money — Merchant or collection account identifier'),
  ('payment.moov.api_user', NULL, 'string', 0, 'Moov Money — API user / client id issued by the provider'),
  ('payment.moov.api_key', NULL, 'string', 1, 'Moov Money — API key / client secret'),
  ('payment.moov.subscription_key', NULL, 'string', 1, 'Moov Money — Subscription key, where the provider issues one'),
  ('payment.moov.callback_secret', NULL, 'string', 1, 'Moov Money — Shared secret used to verify callback signatures'),
  ('payment.moov.settlement_account', NULL, 'string', 0, 'Moov Money — Account funds settle into, for reconciliation')
;
