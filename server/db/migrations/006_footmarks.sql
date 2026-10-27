CREATE TABLE IF NOT EXISTS user_footmarks (
  user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  product_id VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  product_name VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  product_image_path VARCHAR(512) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NULL,
  price_cents BIGINT UNSIGNED NOT NULL,
  viewed_at DATETIME(6) NOT NULL DEFAULT (UTC_TIMESTAMP(6)),
  PRIMARY KEY (user_id, product_id),
  KEY idx_user_footmarks_user_viewed (user_id, viewed_at),
  CONSTRAINT fk_user_footmarks_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE = InnoDB DEFAULT CHARACTER SET = utf8mb4 COLLATE = utf8mb4_bin;
