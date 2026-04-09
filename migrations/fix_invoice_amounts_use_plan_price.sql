-- Optional one-time repair: align premium_amount / total / invoice rows with plan premium rate
-- (Run after deploying code that stores plan_price correctly; safe when plan_price > 0)

UPDATE sales s
SET
  premium_amount = s.plan_price,
  total = s.plan_price + COALESCE(s.tax, 0)
WHERE s.plan_price IS NOT NULL AND s.plan_price > 0;

UPDATE invoices i
JOIN sales s ON s.id = i.sale_id
SET
  i.subtotal = s.plan_price,
  i.total = s.plan_price + COALESCE(i.tax, 0)
WHERE s.plan_price IS NOT NULL AND s.plan_price > 0;
