-- Links multiple cases created from one group subscription (Excel import).
-- Run once on existing databases.

ALTER TABLE `cases`
  ADD COLUMN `group_id` varchar(36) DEFAULT NULL AFTER `created_by`,
  ADD KEY `idx_cases_group_id` (`group_id`);
