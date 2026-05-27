-- AssurAssistance Database Schema
-- Clean SQL for easy copying and execution

-- Drop existing tables if they exist
DROP TABLE IF EXISTS `user_activity`;
DROP TABLE IF EXISTS `users`;
DROP TABLE IF EXISTS `travellers`;
DROP TABLE IF EXISTS `sales_ledger`;
DROP TABLE IF EXISTS `sales`;
DROP TABLE IF EXISTS `password_resets`;
DROP TABLE IF EXISTS `invoices`;
DROP TABLE IF EXISTS `certificates`;
DROP TABLE IF EXISTS `catalogue`;
DROP TABLE IF EXISTS `cases`;

-- Create tables

-- Users table with simplified role system
CREATE TABLE `users` (
  `id` int NOT NULL AUTO_INCREMENT,
  `name` varchar(255) NOT NULL,
  `email` varchar(255) NOT NULL,
  `password` varchar(255) NOT NULL,
  `role` enum('admin','sub_admin','agent') NOT NULL DEFAULT 'agent',
  `status` enum('active','inactive') NOT NULL DEFAULT 'active',
  `force_password_change` tinyint(1) DEFAULT '0',
  `last_login` datetime DEFAULT NULL,
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `email` (`email`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Travellers table
CREATE TABLE `travellers` (
  `id` int NOT NULL AUTO_INCREMENT,
  `full_name` varchar(255) NOT NULL,
  `passport_or_id` varchar(100) DEFAULT NULL,
  `phone` varchar(50) DEFAULT NULL,
  `email` varchar(100) DEFAULT NULL,
  `address` text,
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Catalogue table for insurance plans
CREATE TABLE `catalogue` (
  `id` int NOT NULL AUTO_INCREMENT,
  `product_type` enum('Travel','Travel Inbound','Bank','Health Evacuation','Road travel') NOT NULL,
  `name` varchar(100) NOT NULL,
  `coverage` text NOT NULL,
  `eligible_destinations` text,
  `durations` varchar(255) DEFAULT NULL,
  `pricing_rules` json DEFAULT NULL,
  `flat_price` decimal(10,2) DEFAULT NULL,
  `terms` text,
  `country_of_residence` varchar(255) DEFAULT NULL,
  `route_type` varchar(50) DEFAULT NULL,
  `theme_color` varchar(9) NOT NULL DEFAULT '#E4590F',
  `extra_id_fields` tinyint(1) NOT NULL DEFAULT '0',
  `active` tinyint(1) DEFAULT '1',
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Cases table
CREATE TABLE `cases` (
  `id` int NOT NULL AUTO_INCREMENT,
  `traveller_id` int NOT NULL,
  `destination` varchar(255) NOT NULL,
  `start_date` date NOT NULL,
  `end_date` date NOT NULL,
  `duration_days` int GENERATED ALWAYS AS (((to_days(`end_date`) - to_days(`start_date`)) + 1)) STORED,
  `selected_plan_id` int NOT NULL,
  `status` enum('Draft','Confirmed','Cancelled') DEFAULT 'Draft',
  `created_by` int NOT NULL,
  `group_id` varchar(36) DEFAULT NULL,
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_cases_group_id` (`group_id`),
  KEY `fk_case_traveller` (`traveller_id`),
  KEY `fk_case_plan` (`selected_plan_id`),
  KEY `fk_case_user` (`created_by`),
  CONSTRAINT `fk_case_plan` FOREIGN KEY (`selected_plan_id`) REFERENCES `catalogue` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_case_traveller` FOREIGN KEY (`traveller_id`) REFERENCES `travellers` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_case_user` FOREIGN KEY (`created_by`) REFERENCES `users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Sales table
CREATE TABLE `sales` (
  `id` int NOT NULL AUTO_INCREMENT,
  `case_id` int NOT NULL,
  `policy_number` varchar(50) NOT NULL,
  `certificate_number` varchar(50) NOT NULL,
  `premium_amount` decimal(10,2) NOT NULL,
  `tax` decimal(10,2) DEFAULT '0.00',
  `total` decimal(10,2) NOT NULL,
  `payment_status` enum('Unpaid','Paid','Partial') DEFAULT 'Unpaid',
  `payment_notes` text,
  `confirmed_at` datetime NOT NULL,
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  `received_amount` decimal(10,2) DEFAULT '0.00',
  PRIMARY KEY (`id`),
  UNIQUE KEY `policy_number` (`policy_number`),
  UNIQUE KEY `certificate_number` (`certificate_number`),
  KEY `fk_sale_case` (`case_id`),
  CONSTRAINT `fk_sale_case` FOREIGN KEY (`case_id`) REFERENCES `cases` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Certificates table
CREATE TABLE `certificates` (
  `id` int NOT NULL AUTO_INCREMENT,
  `sale_id` int NOT NULL,
  `certificate_number` varchar(100) NOT NULL,
  `public_token` varchar(64) DEFAULT NULL,
  `pdf_path` varchar(255) DEFAULT NULL,
  `issue_date` datetime DEFAULT CURRENT_TIMESTAMP,
  `coverage_summary` text,
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `certificate_number` (`certificate_number`),
  UNIQUE KEY `uq_certificates_public_token` (`public_token`),
  KEY `fk_certificate_sale` (`sale_id`),
  CONSTRAINT `fk_certificate_sale` FOREIGN KEY (`sale_id`) REFERENCES `sales` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Invoices table
CREATE TABLE `invoices` (
  `id` int NOT NULL AUTO_INCREMENT,
  `sale_id` int NOT NULL,
  `invoice_number` varchar(100) NOT NULL,
  `pdf_path` varchar(255) DEFAULT NULL,
  `subtotal` decimal(10,2) DEFAULT NULL,
  `tax` decimal(10,2) DEFAULT '0.00',
  `total` decimal(10,2) DEFAULT NULL,
  `payment_status` enum('Unpaid','Paid','Partial') DEFAULT 'Unpaid',
  `issue_date` datetime DEFAULT CURRENT_TIMESTAMP,
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `invoice_number` (`invoice_number`),
  KEY `fk_invoice_sale` (`sale_id`),
  CONSTRAINT `fk_invoice_sale` FOREIGN KEY (`sale_id`) REFERENCES `sales` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Password resets table
CREATE TABLE `password_resets` (
  `id` int NOT NULL AUTO_INCREMENT,
  `email` varchar(255) NOT NULL,
  `otp` varchar(6) NOT NULL,
  `expires_at` datetime NOT NULL,
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- User activity table
CREATE TABLE `user_activity` (
  `id` int NOT NULL AUTO_INCREMENT,
  `user_id` int NOT NULL,
  `activity_type` varchar(100) NOT NULL,
  `activity_date` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `user_id` (`user_id`),
  CONSTRAINT `user_activity_ibfk_1` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 3rd-party API keys: hashed secrets, scoped, audited.
CREATE TABLE `api_keys` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `owner_user_id` INT NOT NULL,
  `name` VARCHAR(120) NOT NULL,
  `key_prefix` VARCHAR(32) NOT NULL,
  `key_hash` CHAR(64) NOT NULL,
  `scopes` JSON NOT NULL,
  `ip_allowlist` TEXT DEFAULT NULL,
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

-- Per-request audit log for API key calls.
CREATE TABLE `api_key_usage` (
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

-- Sales ledger view
CREATE VIEW `sales_ledger` AS 
SELECT 
  s.id AS sale_id,
  s.case_id AS case_id,
  c.created_by AS agent_id,
  t.full_name AS traveller_name,
  t.phone AS traveller_phone,
  cat.name AS plan_name,
  cat.product_type AS product_type,
  s.policy_number AS policy_number,
  s.certificate_number AS certificate_number,
  s.premium_amount AS premium_amount,
  s.tax AS tax,
  s.total AS total,
  s.payment_status AS payment_status,
  s.confirmed_at AS confirmed_at
FROM sales s
JOIN cases c ON s.case_id = c.id
JOIN travellers t ON c.traveller_id = t.id
LEFT JOIN catalogue cat ON c.selected_plan_id = cat.id;