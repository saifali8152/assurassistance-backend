-- Add agent profile fields to users table (NULL for admin users)
ALTER TABLE `users`
  ADD COLUMN `company_name` VARCHAR(255) DEFAULT NULL AFTER `updated_at`,
  ADD COLUMN `partnership_type` VARCHAR(100) DEFAULT NULL AFTER `company_name`,
  ADD COLUMN `country_of_residence` VARCHAR(255) DEFAULT NULL AFTER `partnership_type`,
  ADD COLUMN `iata_number` VARCHAR(50) DEFAULT NULL AFTER `country_of_residence`,
  ADD COLUMN `geographical_location` VARCHAR(255) DEFAULT NULL AFTER `iata_number`,
  ADD COLUMN `work_phone` VARCHAR(50) DEFAULT NULL AFTER `geographical_location`,
  ADD COLUMN `whatsapp_phone` VARCHAR(50) DEFAULT NULL AFTER `work_phone`;

-- Junction table: which plans are assigned to which agent
CREATE TABLE IF NOT EXISTS `user_assigned_plans` (
  `user_id` INT NOT NULL,
  `catalogue_id` INT NOT NULL,
  PRIMARY KEY (`user_id`, `catalogue_id`),
  KEY `fk_uap_user` (`user_id`),
  KEY `fk_uap_catalogue` (`catalogue_id`),
  CONSTRAINT `fk_uap_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_uap_catalogue` FOREIGN KEY (`catalogue_id`) REFERENCES `catalogue` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
