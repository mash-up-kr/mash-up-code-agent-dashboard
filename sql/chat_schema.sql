-- Chat feature schema.
--
-- Depends on the `groups` and `members` tables created by db.js > initDB.
-- The chat router (routes/chat.js) also runs the equivalent CREATE TABLE
-- IF NOT EXISTS at startup, so this file is mainly for reference and for
-- bootstrapping the database manually.
--
-- Apply with:
--   mysql -u root -p mashup_claude < sql/chat_schema.sql

CREATE TABLE IF NOT EXISTS messages (
  id         BIGINT       AUTO_INCREMENT PRIMARY KEY,
  group_id   INT          NOT NULL,
  member_id  INT          NOT NULL,
  content    TEXT         NOT NULL,
  created_at TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_group_id (group_id, id),
  FOREIGN KEY (group_id)  REFERENCES `groups`(id) ON DELETE CASCADE,
  FOREIGN KEY (member_id) REFERENCES members(id)  ON DELETE CASCADE
) ENGINE=InnoDB
  DEFAULT CHARSET=utf8mb4
  COLLATE=utf8mb4_unicode_ci;
