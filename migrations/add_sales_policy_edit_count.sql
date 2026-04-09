-- Track post-confirmation policy corrections by non-admin operators (max 3)
ALTER TABLE sales
  ADD COLUMN policy_edit_count INT NOT NULL DEFAULT 0 AFTER payment_status;
