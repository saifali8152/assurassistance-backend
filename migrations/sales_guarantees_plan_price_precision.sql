-- Increase precision for plan_price and guarantees_total (same as premium_amount/total)
-- DECIMAL(10,2) max is 99,999,999.99; DECIMAL(15,2) allows larger amounts (e.g. XOF)
ALTER TABLE `sales`
  MODIFY COLUMN `plan_price` DECIMAL(15,2) DEFAULT 0.00,
  MODIFY COLUMN `guarantees_total` DECIMAL(15,2) DEFAULT 0.00;
