-- Update destination field in cases table to support multiple destinations (stored as comma-separated string)
ALTER TABLE `cases` 
  MODIFY COLUMN `destination` TEXT NOT NULL;

