-- Allow catalogue.coverage to have a default so INSERT without coverage does not fail
ALTER TABLE catalogue MODIFY COLUMN coverage TEXT NULL DEFAULT NULL;
