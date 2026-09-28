-- ----------------------------------------------------------------------------
-- Milestone 2 — destination zone mapping.
--
-- The pricing engine (utils/travelPricing.js) already resolves a premium from
-- `catalogue.pricing_rules.pricingColumns`. Until now that column set has been
-- effectively a single "Worldwide" entry, so destination never affected price.
--
-- This table maps a country to a zone NAME that must match one of the plan's
-- pricingColumns. Unmapped countries fall back to the plan's first column, so
-- behaviour is identical to today until the client supplies a real mapping.
--
-- SAFETY: additive only. New table; existing pricing data is untouched.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `destination_zones` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `country_code` CHAR(2) NOT NULL COMMENT 'ISO 3166-1 alpha-2',
  `country_name_en` VARCHAR(120) NOT NULL,
  `country_name_fr` VARCHAR(120) NOT NULL,
  `zone` VARCHAR(60) NOT NULL COMMENT 'Must match a catalogue.pricing_rules.pricingColumns entry',
  `active` TINYINT(1) NOT NULL DEFAULT 1,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_destination_zones_country` (`country_code`),
  KEY `ix_destination_zones_zone` (`zone`),
  KEY `ix_destination_zones_active` (`active`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
