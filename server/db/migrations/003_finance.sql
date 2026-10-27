CREATE TABLE IF NOT EXISTS account_balances (
  user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  available_balance_cents BIGINT UNSIGNED NOT NULL DEFAULT 0,
  commission_balance_cents BIGINT UNSIGNED NOT NULL DEFAULT 0,
  frozen_balance_cents BIGINT UNSIGNED NOT NULL DEFAULT 0,
  updated_at DATETIME(6) NOT NULL DEFAULT (UTC_TIMESTAMP(6)),
  PRIMARY KEY (user_id),
  CONSTRAINT fk_account_balances_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE = InnoDB DEFAULT CHARACTER SET = utf8mb4 COLLATE = utf8mb4_bin;

INSERT IGNORE INTO account_balances (user_id)
SELECT id FROM users;

CREATE TABLE IF NOT EXISTS account_transactions (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  order_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  reference_no VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  transaction_type VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  direction ENUM('income', 'expense') NOT NULL,
  amount_cents BIGINT UNSIGNED NOT NULL,
  balance_before_cents BIGINT UNSIGNED NOT NULL,
  balance_after_cents BIGINT UNSIGNED NOT NULL,
  note VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NULL,
  created_at DATETIME(6) NOT NULL DEFAULT (UTC_TIMESTAMP(6)),
  PRIMARY KEY (id),
  KEY idx_account_transactions_user_created (user_id, created_at),
  KEY idx_account_transactions_user_type_created (user_id, transaction_type, created_at),
  CONSTRAINT fk_account_transactions_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE RESTRICT,
  CONSTRAINT fk_account_transactions_order FOREIGN KEY (order_id) REFERENCES orders (id) ON DELETE SET NULL
) ENGINE = InnoDB DEFAULT CHARACTER SET = utf8mb4 COLLATE = utf8mb4_bin;

CREATE TABLE IF NOT EXISTS recharge_orders (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  recharge_number VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  amount_cents BIGINT UNSIGNED NOT NULL,
  channel ENUM('alipay', 'topup_card') NOT NULL,
  status ENUM('pending_payment', 'paid', 'failed', 'closed') NOT NULL DEFAULT 'pending_payment',
  created_at DATETIME(6) NOT NULL DEFAULT (UTC_TIMESTAMP(6)),
  updated_at DATETIME(6) NOT NULL DEFAULT (UTC_TIMESTAMP(6)),
  PRIMARY KEY (id),
  UNIQUE KEY uq_recharge_orders_number (recharge_number),
  KEY idx_recharge_orders_user_created (user_id, created_at),
  CONSTRAINT fk_recharge_orders_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE RESTRICT
) ENGINE = InnoDB DEFAULT CHARACTER SET = utf8mb4 COLLATE = utf8mb4_bin;
