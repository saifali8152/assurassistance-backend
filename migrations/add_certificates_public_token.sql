-- Public share link for certificate verification (QR code). Run once on existing DBs.
ALTER TABLE `certificates`
  ADD COLUMN `public_token` VARCHAR(64) NULL DEFAULT NULL AFTER `certificate_number`,
  ADD UNIQUE KEY `uq_certificates_public_token` (`public_token`);
