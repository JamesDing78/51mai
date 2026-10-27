CREATE TABLE payment_notifications (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  provider ENUM('wechat','alipay') NOT NULL,
  notification_id VARCHAR(128) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  order_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  payload_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  status ENUM('received','processed','rejected') NOT NULL DEFAULT 'received',
  received_at DATETIME(6) NOT NULL DEFAULT (UTC_TIMESTAMP(6)),
  processed_at DATETIME(6) NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_payment_notification (provider, notification_id),
  KEY idx_payment_notification_order (order_id),
  CONSTRAINT fk_payment_notification_order FOREIGN KEY (order_id) REFERENCES orders (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARACTER SET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE payment_transactions (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  order_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  provider ENUM('wechat','alipay') NOT NULL,
  provider_trade_no VARCHAR(128) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  amount_cents BIGINT UNSIGNED NOT NULL,
  status ENUM('paid','refunded') NOT NULL DEFAULT 'paid',
  paid_at DATETIME(6) NOT NULL DEFAULT (UTC_TIMESTAMP(6)),
  PRIMARY KEY (id),
  UNIQUE KEY uq_payment_trade (provider, provider_trade_no),
  KEY idx_payment_order (order_id),
  CONSTRAINT fk_payment_transaction_order FOREIGN KEY (order_id) REFERENCES orders (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARACTER SET=utf8mb4 COLLATE=utf8mb4_bin;
