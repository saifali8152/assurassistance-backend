-- Fixed duration-table premiums (e.g. Agico Retail / Road Travel Burundi).
-- When enabled:
--   • stay length maps to the plan's own pricing-row durations (10/32/45/63/93/180/365, …)
--   • the table price is used as-is (no age multipliers)
--   • the premium is printed on the insurance certificate
ALTER TABLE `catalogue`
  ADD COLUMN `fixed_duration_premiums` TINYINT(1) NOT NULL DEFAULT 0
  AFTER `extra_id_fields`;

-- Turn on for the two Agico Burundi plans when they already exist
UPDATE `catalogue`
SET `fixed_duration_premiums` = 1,
    `active` = 1
WHERE `name` IN (
  'Agico Retail Burundi',
  'AGICO Retail Burundi',
  'Agico Road Travel Burundi',
  'AGICO Road Travel Burundi'
);
