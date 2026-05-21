-- Sub-administrator role for field sales reps:
--   * Can create travel-agency accounts (regular agents).
--   * Sees only cases/agents whose chain of ownership begins at them.
--   * Edits cases like an admin, but scoped to that visibility.
ALTER TABLE `users`
  MODIFY COLUMN `role` ENUM('admin','sub_admin','agent') NOT NULL DEFAULT 'agent',
  ADD COLUMN `created_by_id` INT DEFAULT NULL AFTER `parent_agent_id`,
  ADD KEY `fk_users_created_by` (`created_by_id`),
  ADD CONSTRAINT `fk_users_created_by` FOREIGN KEY (`created_by_id`) REFERENCES `users` (`id`) ON DELETE SET NULL;
