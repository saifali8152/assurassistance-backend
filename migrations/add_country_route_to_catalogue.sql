-- Migration: Add country_of_residence and route_type to catalogue table
-- Date: 2024

ALTER TABLE `catalogue` 
ADD COLUMN `country_of_residence` VARCHAR(255) DEFAULT NULL AFTER `terms`,
ADD COLUMN `route_type` VARCHAR(50) DEFAULT NULL AFTER `country_of_residence`;

-- Update product_type enum to include 'Road travel'
ALTER TABLE `catalogue` 
MODIFY COLUMN `product_type` ENUM('Travel', 'Travel Inbound', 'Bank', 'Health Evacuation', 'Road travel') NOT NULL;

