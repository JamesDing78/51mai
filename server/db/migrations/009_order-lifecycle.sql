ALTER TABLE order_items
  ADD COLUMN spec_id VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NULL AFTER product_id;

ALTER TABLE orders
  ADD COLUMN expires_at DATETIME(6) NULL AFTER total_amount_cents,
  ADD COLUMN cancelled_at DATETIME(6) NULL AFTER expires_at,
  ADD COLUMN cancel_reason VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL AFTER cancelled_at,
  ADD COLUMN stock_released_at DATETIME(6) NULL AFTER cancel_reason,
  ADD KEY idx_orders_expiry (status, payment_status, expires_at);
