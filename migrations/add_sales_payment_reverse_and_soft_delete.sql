-- Paid policy reverse limit + soft-delete (policies remain visible with zeroed amounts).
-- payment_reverse_count: how many times Admin has changed Paid → Unpaid (max 2).
-- Soft-delete keeps the row; UI/API present premium/commission as 0.

ALTER TABLE `sales`
  ADD COLUMN `payment_reverse_count` INT NOT NULL DEFAULT 0
    COMMENT 'Times Paid→Unpaid was applied by Admin (max 2)' AFTER `payment_notes`,
  ADD COLUMN `deleted_at` DATETIME NULL DEFAULT NULL
    COMMENT 'Soft-delete timestamp; NULL = active policy' AFTER `payment_reverse_count`,
  ADD COLUMN `deleted_by_user_id` INT NULL DEFAULT NULL AFTER `deleted_at`,
  ADD COLUMN `deletion_reason` VARCHAR(100) NULL DEFAULT NULL
    COMMENT 'Test policy | Customer desistement | Error or duplicate | Cancellation before reversal'
    AFTER `deleted_by_user_id`,
  ADD KEY `idx_sales_deleted_at` (`deleted_at`),
  ADD CONSTRAINT `fk_sales_deleted_by`
    FOREIGN KEY (`deleted_by_user_id`) REFERENCES `users` (`id`) ON DELETE SET NULL;
