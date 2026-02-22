-- Migration: Add currency to catalogue table
-- Date: 2024

ALTER TABLE `catalogue` 
ADD COLUMN `currency` VARCHAR(3) DEFAULT 'XOF' AFTER `route_type`;

-- Update existing records to have XOF as default currency
UPDATE `catalogue` SET `currency` = 'XOF' WHERE `currency` IS NULL;

