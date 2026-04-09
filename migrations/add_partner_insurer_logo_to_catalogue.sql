-- Partner insurer logo for certificate header (path under /uploads/plan-logos/...)
ALTER TABLE `catalogue`
  ADD COLUMN `partner_insurer_logo` VARCHAR(512) NULL DEFAULT NULL
  AFTER `currency`;
