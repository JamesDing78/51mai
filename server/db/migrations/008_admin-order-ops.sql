ALTER TABLE orders
  ADD COLUMN manual_processing_status ENUM('none','reviewing','held') NOT NULL DEFAULT 'none' AFTER delivery_status,
  ADD COLUMN admin_note VARCHAR(500) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NULL AFTER manual_processing_status;
