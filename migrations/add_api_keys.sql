-- ----------------------------------------------------------------------------
-- 3rd-party API key infrastructure.
--
-- An API key acts on behalf of an owner user (typically an agent or sub_admin).
-- The key inherits that user's visibility scope (e.g. an agent's API key can
-- only see cases under that agent's hierarchy) and is further constrained by
-- the `scopes` list it was issued with.
--
-- Secrets are stored as SHA-256 hashes — only the prefix (first ~12 chars) is
-- kept in clear text so the admin can identify a key in lists. The full secret
-- is shown only once at creation time.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `api_keys` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `owner_user_id` INT NOT NULL,
  `name` VARCHAR(120) NOT NULL,
  -- First ~12 visible characters of the issued key, e.g. "aas_live_4f9a"
  `key_prefix` VARCHAR(32) NOT NULL,
  -- SHA-256 hex digest of the full secret (64 chars). Never store the secret.
  `key_hash` CHAR(64) NOT NULL,
  -- JSON array of permission strings, e.g. ["cases:read","sales:read"]
  `scopes` JSON NOT NULL,
  -- Optional CSV of CIDR / IPs the key is allowed to be used from.
  `ip_allowlist` TEXT DEFAULT NULL,
  -- Per-key override of the default rate limit (requests per minute).
  `rate_limit_per_min` INT DEFAULT NULL,
  `status` ENUM('active','revoked') NOT NULL DEFAULT 'active',
  `expires_at` DATETIME DEFAULT NULL,
  `last_used_at` DATETIME DEFAULT NULL,
  `last_used_ip` VARCHAR(45) DEFAULT NULL,
  `created_by_user_id` INT NOT NULL,
  `created_at` TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
  `revoked_at` DATETIME DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_api_keys_key_hash` (`key_hash`),
  KEY `ix_api_keys_owner_user_id` (`owner_user_id`),
  KEY `ix_api_keys_status` (`status`),
  KEY `ix_api_keys_key_prefix` (`key_prefix`),
  CONSTRAINT `fk_api_keys_owner` FOREIGN KEY (`owner_user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_api_keys_creator` FOREIGN KEY (`created_by_user_id`) REFERENCES `users` (`id`) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Per-request audit log for API key calls. Keep payload minimal — no request
-- bodies — to avoid logging PII; the `path`+`status`+`elapsed_ms` triple is
-- enough for usage analytics and abuse investigation.
CREATE TABLE IF NOT EXISTS `api_key_usage` (
  `id` BIGINT NOT NULL AUTO_INCREMENT,
  `api_key_id` INT NOT NULL,
  `method` VARCHAR(10) NOT NULL,
  `path` VARCHAR(255) NOT NULL,
  `status_code` SMALLINT NOT NULL,
  `ip` VARCHAR(45) DEFAULT NULL,
  `user_agent` VARCHAR(255) DEFAULT NULL,
  `elapsed_ms` INT DEFAULT NULL,
  `created_at` TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `ix_api_key_usage_api_key_id_created_at` (`api_key_id`, `created_at`),
  CONSTRAINT `fk_api_key_usage_key` FOREIGN KEY (`api_key_id`) REFERENCES `api_keys` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
