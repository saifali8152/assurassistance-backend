-- ----------------------------------------------------------------------------
-- Repair the `sales_ledger` view.
--
-- THE BUG (pre-existing, found while setting up backups in September 2026):
-- the view was created selecting `t.full_name AS traveller_name`, and the later
-- migration `update_travellers_table.sql` DROPPED `travellers.full_name`,
-- replacing it with `first_name` + `last_name`.
--
-- MySQL does not re-validate a view when a column it references disappears, so
-- the view stayed broken and silent. Nothing in the application reads it —
-- ledgerModel.js builds its own joins — which is why it went unnoticed. It
-- surfaced as:
--
--   mysqldump: Couldn't execute 'SHOW FIELDS FROM `sales_ledger`': View
--   'sales_ledger' references invalid table(s) or column(s) ... (1356)
--
-- That is worth fixing on its own terms: a broken view breaks mysqldump, which
-- means it breaks BACKUPS.
--
-- SAFETY: a view stores no data. CREATE OR REPLACE VIEW rewrites a definition
-- and touches nothing in `sales`, `cases`, `travellers` or `catalogue`. It is
-- idempotent, so re-running is a no-op.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE VIEW `sales_ledger` AS
SELECT
  s.id AS sale_id,
  s.case_id AS case_id,
  c.created_by AS agent_id,
  -- Was `t.full_name`; that column no longer exists.
  CONCAT(t.first_name, ' ', t.last_name) AS traveller_name,
  t.phone AS traveller_phone,
  cat.name AS plan_name,
  cat.product_type AS product_type,
  s.policy_number AS policy_number,
  s.certificate_number AS certificate_number,
  s.premium_amount AS premium_amount,
  s.tax AS tax,
  s.total AS total,
  s.payment_status AS payment_status,
  s.confirmed_at AS confirmed_at
FROM sales s
JOIN cases c ON s.case_id = c.id
JOIN travellers t ON c.traveller_id = t.id
LEFT JOIN catalogue cat ON c.selected_plan_id = cat.id;
