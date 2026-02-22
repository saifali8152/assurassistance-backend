-- Add pricing and currency fields to sales table
ALTER TABLE `sales`
ADD COLUMN `currency` VARCHAR(3) DEFAULT 'XOF' AFTER `total`,
ADD COLUMN `plan_price` DECIMAL(10,2) DEFAULT 0.00 AFTER `currency`,
ADD COLUMN `guarantees_total` DECIMAL(10,2) DEFAULT 0.00 AFTER `plan_price`,
ADD COLUMN `guarantees_details` JSON DEFAULT NULL AFTER `guarantees_total`;

-- Update existing records to have default values
UPDATE `sales` SET `currency` = 'XOF' WHERE `currency` IS NULL;
UPDATE `sales` SET `plan_price` = `premium_amount` WHERE `plan_price` IS NULL OR `plan_price` = 0.00;
UPDATE `sales` SET `guarantees_total` = 0.00 WHERE `guarantees_total` IS NULL;

