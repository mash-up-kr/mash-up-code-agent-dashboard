-- Chat feature schema.
--
-- Apply with:
--   mysql -u root -p < sql/chat_schema.sql
--
-- Override connection via environment variables consumed by chat.js:
--   CHAT_DB_HOST   (default: localhost)
--   CHAT_DB_PORT   (default: 3306)
--   CHAT_DB_USER   (default: root)
--   CHAT_DB_PASS   (default: empty)
--   CHAT_DB_NAME   (default: chat_db)

CREATE DATABASE IF NOT EXISTS chat_db
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

USE chat_db;

CREATE TABLE IF NOT EXISTS messages (
  id         BIGINT AUTO_INCREMENT PRIMARY KEY,
  user_name  VARCHAR(64) NOT NULL,
  content    TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_created (created_at)
) ENGINE=InnoDB
  DEFAULT CHARSET=utf8mb4
  COLLATE=utf8mb4_unicode_ci;
