ALTER TABLE orders
  ADD COLUMN client_request_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL AFTER user_id,
  ADD UNIQUE KEY uq_orders_user_client_request (user_id, client_request_id);

ALTER TABLE order_items
  ADD COLUMN partner_cost_cents BIGINT UNSIGNED NULL AFTER unit_price_cents,
  ADD COLUMN delivery_type ENUM('card', 'content') NULL AFTER partner_cost_cents;

CREATE TABLE local_product_inventory (
  product_id VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  spec_id VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  available_quantity INT UNSIGNED NOT NULL,
  updated_at DATETIME(6) NOT NULL DEFAULT (UTC_TIMESTAMP(6)),
  PRIMARY KEY (product_id, spec_id)
) ENGINE = InnoDB DEFAULT CHARACTER SET = utf8mb4 COLLATE = utf8mb4_bin;
