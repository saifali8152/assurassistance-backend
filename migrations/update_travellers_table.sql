-- Update travellers table to replace full_name with first_name, last_name and add new fields
ALTER TABLE `travellers` 
  ADD COLUMN `first_name` VARCHAR(255) NULL AFTER `id`,
  ADD COLUMN `last_name` VARCHAR(255) NULL AFTER `first_name`,
  ADD COLUMN `date_of_birth` DATE NULL AFTER `last_name`,
  ADD COLUMN `country_of_residence` VARCHAR(255) NULL AFTER `date_of_birth`,
  ADD COLUMN `gender` ENUM('Male', 'Female', 'Other') NULL AFTER `country_of_residence`,
  ADD COLUMN `nationality` VARCHAR(255) NULL AFTER `gender`;

-- Migrate existing full_name data to first_name and last_name (split by space)
UPDATE `travellers` 
SET 
  `first_name` = SUBSTRING_INDEX(`full_name`, ' ', 1),
  `last_name` = CASE 
    WHEN LOCATE(' ', `full_name`) > 0 
    THEN SUBSTRING(`full_name`, LOCATE(' ', `full_name`) + 1)
    ELSE ''
  END
WHERE `full_name` IS NOT NULL AND `full_name` != '';

-- Make first_name and last_name NOT NULL after migration
ALTER TABLE `travellers` 
  MODIFY COLUMN `first_name` VARCHAR(255) NOT NULL,
  MODIFY COLUMN `last_name` VARCHAR(255) NOT NULL;

-- Drop the old full_name column
ALTER TABLE `travellers` DROP COLUMN `full_name`;

