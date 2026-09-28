-- ----------------------------------------------------------------------------
-- Milestone 2 — migration ledger.
--
-- Records which .sql files the runner (scripts/migrate.js) has already applied,
-- so a re-run against the live database is a no-op instead of an error.
--
-- SAFETY: additive only. Creates one new table and touches nothing existing.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `schema_migrations` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `filename` VARCHAR(255) NOT NULL,
  -- SHA-256 of the file contents at apply time, so an edited migration is visible.
  `checksum` CHAR(64) NOT NULL,
  -- 'applied' = executed by the runner; 'baseline' = pre-existing schema marked
  -- as already present on the live database without being executed.
  `state` ENUM('applied','baseline') NOT NULL DEFAULT 'applied',
  `applied_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `execution_ms` INT UNSIGNED NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_schema_migrations_filename` (`filename`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
