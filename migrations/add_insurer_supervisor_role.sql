-- Insurer supervisor accounts:
--   * Role can issue travel policies, create agencies/subaccounts, and report
--     only on policies whose catalogue plan belongs to their partner_insurer.
--   * catalogue.partner_insurer tags plans (e.g. gna, agico).
--   * users.partner_insurer binds an insurer_supervisor to that key.

ALTER TABLE `users`
  MODIFY COLUMN `role` ENUM('admin','sub_admin','insurer_supervisor','agent') NOT NULL DEFAULT 'agent';

ALTER TABLE `users`
  ADD COLUMN `partner_insurer` VARCHAR(64) NULL DEFAULT NULL
    COMMENT 'Insurer key for insurer_supervisor (e.g. gna, agico)'
    AFTER `created_by_id`,
  ADD KEY `idx_users_partner_insurer` (`partner_insurer`);

ALTER TABLE `catalogue`
  ADD COLUMN `partner_insurer` VARCHAR(64) NULL DEFAULT NULL
    COMMENT 'Owning insurer key (e.g. gna, agico) for plan scoping'
    AFTER `partner_insurer_logo`,
  ADD KEY `idx_catalogue_partner_insurer` (`partner_insurer`);

-- Best-effort seed from existing plan names (CI GNA + Burundi AGICO).
UPDATE `catalogue`
SET `partner_insurer` = 'gna'
WHERE `partner_insurer` IS NULL
  AND LOWER(`name`) LIKE '%gna%';

UPDATE `catalogue`
SET `partner_insurer` = 'agico'
WHERE `partner_insurer` IS NULL
  AND LOWER(`name`) LIKE '%agico%';
