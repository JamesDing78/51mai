CREATE TABLE delivery_assets (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  product_id VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  spec_id VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  delivery_kind ENUM('card','content') NOT NULL,
  payload_ciphertext TEXT CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  payload_iv VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  payload_tag VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  status ENUM('available','assigned') NOT NULL DEFAULT 'available',
  assigned_order_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  created_at DATETIME(6) NOT NULL DEFAULT (UTC_TIMESTAMP(6)),
  assigned_at DATETIME(6) NULL,
  PRIMARY KEY (id),
  KEY idx_delivery_assets_available (product_id,spec_id,delivery_kind,status,created_at),
  KEY idx_delivery_assets_order (assigned_order_id),
  CONSTRAINT fk_delivery_assets_order FOREIGN KEY (assigned_order_id) REFERENCES orders(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARACTER SET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE fulfillment_jobs (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  order_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  mode ENUM('auto','manual') NOT NULL,
  status ENUM('pending','processing','completed','failed') NOT NULL,
  last_error VARCHAR(500) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NULL,
  created_at DATETIME(6) NOT NULL DEFAULT (UTC_TIMESTAMP(6)),
  updated_at DATETIME(6) NOT NULL DEFAULT (UTC_TIMESTAMP(6)),
  PRIMARY KEY (id),
  UNIQUE KEY uq_fulfillment_order (order_id),
  KEY idx_fulfillment_status (status,updated_at),
  CONSTRAINT fk_fulfillment_order FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARACTER SET=utf8mb4 COLLATE=utf8mb4_bin;

ALTER TABLE order_delivery_items
  ADD COLUMN payload_ciphertext TEXT CHARACTER SET ascii COLLATE ascii_bin NULL AFTER credential_state,
  ADD COLUMN payload_iv VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NULL AFTER payload_ciphertext,
  ADD COLUMN payload_tag VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NULL AFTER payload_iv;
