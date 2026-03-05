-- Increase decimal precision for sales amounts (XOF/FCFA can be large)
-- decimal(10,2) max is 99,999,999.99; decimal(15,2) allows up to 9,999,999,999,999.99
ALTER TABLE `sales`
  MODIFY COLUMN `premium_amount` DECIMAL(15,2) NOT NULL,
  MODIFY COLUMN `tax` DECIMAL(15,2) DEFAULT '0.00',
  MODIFY COLUMN `total` DECIMAL(15,2) NOT NULL,
  MODIFY COLUMN `received_amount` DECIMAL(15,2) DEFAULT '0.00';
