-- Contractual documentation (Terms & Conditions) downloadable by all logged-in users.
-- Only Admin may upload / replace. Two fixed slots: full | brief.

CREATE TABLE IF NOT EXISTS `contractual_documents` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `doc_key` ENUM('full', 'brief') NOT NULL COMMENT 'full = Version Complète; brief = Version Brève',
  `title` VARCHAR(255) NOT NULL,
  `description` VARCHAR(1000) NOT NULL,
  `file_path` VARCHAR(500) NOT NULL COMMENT 'Public path under /uploads/…',
  `original_filename` VARCHAR(255) NULL,
  `mime_type` VARCHAR(120) NULL,
  `file_size` INT UNSIGNED NULL,
  `uploaded_by_user_id` INT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_contractual_doc_key` (`doc_key`),
  KEY `idx_contractual_uploaded_by` (`uploaded_by_user_id`),
  CONSTRAINT `fk_contractual_uploaded_by`
    FOREIGN KEY (`uploaded_by_user_id`) REFERENCES `users` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
