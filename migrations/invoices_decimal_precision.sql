-- Increase decimal precision for invoice amounts (align with sales table)
ALTER TABLE `invoices`
  MODIFY COLUMN `subtotal` DECIMAL(15,2) DEFAULT NULL,
  MODIFY COLUMN `tax` DECIMAL(15,2) DEFAULT '0.00',
  MODIFY COLUMN `total` DECIMAL(15,2) DEFAULT NULL;
