'use strict';

const mysql = require('mysql2/promise');

const pool = mysql.createPool({
  host:     process.env.DB_HOST     || 'localhost',
  port:     Number(process.env.DB_PORT) || 3306,
  user:     process.env.DB_USER     || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME     || 'mashup_claude',
  waitForConnections: true,
  connectionLimit:    10,
});

async function initDB() {
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS \`groups\` (
      id          INT          AUTO_INCREMENT PRIMARY KEY,
      name        VARCHAR(100) NOT NULL,
      code        CHAR(8)      NOT NULL UNIQUE,
      max_members INT          DEFAULT 20,
      created_at  TIMESTAMP    DEFAULT CURRENT_TIMESTAMP
    )
  `);
  // 기존 테이블에 max_members 컬럼이 없는 경우 추가
  try {
    await pool.execute('ALTER TABLE `groups` ADD COLUMN max_members INT DEFAULT 20');
  } catch (_) { /* 이미 존재하면 무시 */ }

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS members (
      id            INT          AUTO_INCREMENT PRIMARY KEY,
      username      VARCHAR(50)  NOT NULL UNIQUE,
      password_hash VARCHAR(255) NOT NULL,
      name          VARCHAR(50)  NOT NULL,
      created_at    TIMESTAMP    DEFAULT CURRENT_TIMESTAMP
    )
  `);
  // 기존 테이블 마이그레이션
  for (const sql of [
    "ALTER TABLE members ADD COLUMN username VARCHAR(50) NOT NULL DEFAULT ''",
    "ALTER TABLE members ADD COLUMN password_hash VARCHAR(255) NOT NULL DEFAULT ''",
    "ALTER TABLE members ADD COLUMN name VARCHAR(50) NOT NULL DEFAULT ''",
    "ALTER TABLE members ADD UNIQUE (username)",
    "ALTER TABLE members DROP COLUMN nickname",
    "ALTER TABLE members ADD COLUMN hook_token VARCHAR(64) UNIQUE",
  ]) {
    try { await pool.execute(sql); } catch (_) {}
  }

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS member_events (
      id           INT          AUTO_INCREMENT PRIMARY KEY,
      member_id    INT          NOT NULL,
      session_id   VARCHAR(100),
      hook_event   VARCHAR(50),
      tool_name    VARCHAR(50),
      cwd          VARCHAR(500),
      project_name VARCHAR(200),
      created_at   TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_member_date    (member_id, created_at),
      INDEX idx_member_project (member_id, project_name, created_at),
      FOREIGN KEY (member_id) REFERENCES members(id) ON DELETE CASCADE
    )
  `);

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS group_members (
      id         INT          AUTO_INCREMENT PRIMARY KEY,
      group_id   INT          NOT NULL,
      member_id  INT          NOT NULL,
      nickname   VARCHAR(50)  NOT NULL DEFAULT '',
      is_creator TINYINT(1)   DEFAULT 0,
      joined_at  TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_group_member (group_id, member_id),
      FOREIGN KEY (group_id)  REFERENCES \`groups\`(id)  ON DELETE CASCADE,
      FOREIGN KEY (member_id) REFERENCES members(id)     ON DELETE CASCADE
    )
  `);
  // 기존 테이블에 nickname 컬럼이 없는 경우 추가
  try {
    await pool.execute("ALTER TABLE group_members ADD COLUMN nickname VARCHAR(50) NOT NULL DEFAULT ''");
  } catch (_) { /* 이미 존재하면 무시 */ }
}

module.exports = { pool, initDB };