-- Per-plan certificate / invoice theme color and extended ID labelling flag
ALTER TABLE `catalogue`
  ADD COLUMN `theme_color` VARCHAR(9) NOT NULL DEFAULT '#E4590F',
  ADD COLUMN `extra_id_fields` TINYINT(1) NOT NULL DEFAULT 0;
