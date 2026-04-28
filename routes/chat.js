'use strict';

/*
 * Chat router.
 *
 * Group-scoped chat using SSE for real-time delivery and MySQL for persistence.
 * Reuses the shared pool from db.js, the session-based auth from routes/auth.js,
 * and group_members.nickname for display names.
 *
 * Endpoints (mounted at /api/chat):
 *   GET  /groups/:groupId/stream    — SSE subscribe (auth + membership required)
 *   POST /groups/:groupId/messages  — send a message (auth + membership required)
 *   GET  /groups/:groupId/messages  — fetch recent history (?limit=50)
 */

const { Router } = require('express');
const { pool }   = require('../db');

const router = Router();

const HISTORY_LIMIT_DEFAULT = 50;
const HISTORY_LIMIT_MAX     = 200;
const CONTENT_MAX_LENGTH    = 2000;

// groupId -> Map<res, { memberId, nickname }>
const groupClients = new Map();

// ── Schema bootstrap ───────────────────────────────────────

let schemaReady = null;
async function ensureSchema() {
  if (schemaReady) return schemaReady;
  schemaReady = (async () => {
    // No FOREIGN KEY constraints: the referenced tables may use a different
    // engine (e.g. MyISAM on some environments) which makes the FK fail with
    // "Failed to open the referenced table". Group/member integrity is
    // already enforced at the application layer (requireGroupMembership).
    await pool.execute(`
      CREATE TABLE IF NOT EXISTS messages (
        id         BIGINT       AUTO_INCREMENT PRIMARY KEY,
        group_id   INT          NOT NULL,
        member_id  INT          NOT NULL,
        content    TEXT         NOT NULL,
        created_at TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_group_id (group_id, id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    // Per-(member, group) bookmark of the last message the user saw. Used to
    // compute KakaoTalk-style unread badges on the group list.
    await pool.execute(`
      CREATE TABLE IF NOT EXISTS group_member_reads (
        member_id            INT       NOT NULL,
        group_id             INT       NOT NULL,
        last_read_message_id BIGINT    DEFAULT 0,
        updated_at           TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (member_id, group_id),
        INDEX idx_member (member_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
  })();
  // Don't cache failures — clear schemaReady so the next call can retry.
  schemaReady.catch(() => { schemaReady = null; });
  return schemaReady;
}
ensureSchema().catch(err => console.error('[chat] schema init failed:', err));

// ── Middleware ─────────────────────────────────────────────

function requireAuth(req, res, next) {
  if (!req.session.memberId) return res.status(401).json({ error: '로그인이 필요합니다.' });
  next();
}

async function requireGroupMembership(req, res, next) {
  const groupId = Number(req.params.groupId);
  if (!groupId) return res.status(400).json({ error: 'groupId가 필요합니다.' });

  try {
    const [rows] = await pool.execute(
      `SELECT gm.id, gm.nickname, g.max_members
         FROM group_members gm
         JOIN \`groups\` g ON g.id = gm.group_id
        WHERE gm.group_id = ? AND gm.member_id = ?`,
      [groupId, req.session.memberId]
    );
    if (rows.length === 0) return res.status(403).json({ error: '해당 그룹의 멤버가 아닙니다.' });

    req.chat = {
      groupId,
      nickname:   rows[0].nickname,
      maxMembers: rows[0].max_members,
    };
    next();
  } catch (e) {
    console.error('[chat] membership check failed:', e);
    res.status(500).json({ error: '권한 확인 중 오류가 발생했습니다.' });
  }
}

// ── Helpers ────────────────────────────────────────────────

function broadcastToGroup(groupId, eventName, data) {
  const map = groupClients.get(groupId);
  if (!map) return;
  const payload = `event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of map.keys()) {
    try { res.write(payload); } catch (_) { map.delete(res); }
  }
}

// Snapshot of currently-connected members for a group (deduped by memberId).
function presenceFor(groupId) {
  const map = groupClients.get(groupId);
  if (!map) return [];
  const seen = new Set();
  const list = [];
  for (const info of map.values()) {
    if (seen.has(info.memberId)) continue;
    seen.add(info.memberId);
    list.push({ memberId: info.memberId, nickname: info.nickname });
  }
  return list;
}

async function fetchRecentMessages(groupId, limit) {
  const safeLimit = Math.min(Math.max(Number(limit) || HISTORY_LIMIT_DEFAULT, 1), HISTORY_LIMIT_MAX);
  const [rows] = await pool.execute(
    `SELECT m.id, m.group_id AS groupId, m.member_id AS memberId,
            gm.nickname, m.content, m.created_at AS createdAt
       FROM (
         SELECT id, group_id, member_id, content, created_at
           FROM messages
          WHERE group_id = ?
          ORDER BY id DESC
          LIMIT ${safeLimit}
       ) m
       LEFT JOIN group_members gm
              ON gm.group_id = m.group_id AND gm.member_id = m.member_id`,
    [groupId]
  );
  return rows.reverse();
}

// ── Routes ─────────────────────────────────────────────────

router.get('/groups/:groupId/stream', requireAuth, requireGroupMembership, async (req, res) => {
  await ensureSchema();
  const { groupId, nickname } = req.chat;
  const memberId = req.session.memberId;

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection:      'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('event: connected\ndata: {}\n\n');

  try {
    const recent = await fetchRecentMessages(groupId, HISTORY_LIMIT_DEFAULT);
    res.write(`event: init\ndata: ${JSON.stringify({ messages: recent })}\n\n`);
  } catch (err) {
    console.error('[chat] init load failed:', err);
    res.write(`event: init\ndata: ${JSON.stringify({ messages: [] })}\n\n`);
  }

  if (!groupClients.has(groupId)) groupClients.set(groupId, new Map());
  const map = groupClients.get(groupId);
  map.set(res, { memberId, nickname });

  // Notify everyone (including the new joiner) of the new presence list.
  broadcastToGroup(groupId, 'presence', { members: presenceFor(groupId) });

  const keepAlive = setInterval(() => {
    try { res.write(': ping\n\n'); }
    catch (_) { clearInterval(keepAlive); }
  }, 30_000);

  req.on('close', () => {
    map.delete(res);
    clearInterval(keepAlive);
    if (map.size === 0) {
      groupClients.delete(groupId);
    } else {
      broadcastToGroup(groupId, 'presence', { members: presenceFor(groupId) });
    }
  });
});

router.post('/groups/:groupId/messages', requireAuth, requireGroupMembership, async (req, res) => {
  await ensureSchema();
  const { groupId, nickname } = req.chat;
  const memberId = req.session.memberId;

  const content = String(req.body?.content || '').trim();
  if (!content) return res.status(400).json({ error: '메시지 내용을 입력해주세요.' });
  if (content.length > CONTENT_MAX_LENGTH) {
    return res.status(400).json({ error: `메시지는 ${CONTENT_MAX_LENGTH}자 이하로 작성해주세요.` });
  }

  try {
    const [result] = await pool.execute(
      'INSERT INTO messages (group_id, member_id, content) VALUES (?, ?, ?)',
      [groupId, memberId, content]
    );
    const message = {
      id:        result.insertId,
      groupId,
      memberId,
      nickname,
      content,
      createdAt: new Date(),
    };
    broadcastToGroup(groupId, 'chat', message);
    res.status(201).json({ ok: true, message });
  } catch (e) {
    console.error('[chat] insert failed:', e);
    res.status(500).json({ error: '메시지 전송 중 오류가 발생했습니다.' });
  }
});

router.get('/groups/:groupId/messages', requireAuth, requireGroupMembership, async (req, res) => {
  await ensureSchema();
  const { groupId } = req.chat;
  const limit = Number(req.query.limit) || HISTORY_LIMIT_DEFAULT;
  try {
    const messages = await fetchRecentMessages(groupId, limit);
    res.json({ messages });
  } catch (e) {
    console.error('[chat] history load failed:', e);
    res.status(500).json({ error: '메시지 내역을 불러오지 못했습니다.' });
  }
});

// GET /api/chat/unread
// Returns one row per group the user belongs to:
//   { groupId, lastMessageId, lastReadId, unreadCount }
// The frontend uses this to draw KakaoTalk-style badges on group cards.
router.get('/unread', requireAuth, async (req, res) => {
  await ensureSchema();
  const memberId = req.session.memberId;
  try {
    const [rows] = await pool.execute(`
      SELECT
        gm.group_id AS groupId,
        COALESCE(latest.last_id, 0) AS lastMessageId,
        COALESCE(r.last_read_message_id, 0) AS lastReadId,
        COALESCE((
          SELECT COUNT(*) FROM messages
           WHERE group_id = gm.group_id
             AND id > COALESCE(r.last_read_message_id, 0)
        ), 0) AS unreadCount
      FROM group_members gm
      LEFT JOIN (
        SELECT group_id, MAX(id) AS last_id
          FROM messages
         GROUP BY group_id
      ) latest ON latest.group_id = gm.group_id
      LEFT JOIN group_member_reads r
        ON r.group_id = gm.group_id AND r.member_id = gm.member_id
      WHERE gm.member_id = ?
    `, [memberId]);
    res.json({
      unread: rows.map(r => ({
        groupId:       Number(r.groupId),
        lastMessageId: Number(r.lastMessageId),
        lastReadId:    Number(r.lastReadId),
        unreadCount:   Number(r.unreadCount),
      })),
    });
  } catch (e) {
    console.error('[chat] unread query failed:', e);
    res.status(500).json({ error: '읽지 않은 메시지 정보를 불러오지 못했습니다.' });
  }
});

// POST /api/chat/groups/:groupId/read
// Body: { messageId? }. If omitted, marks the group's latest message as read.
router.post('/groups/:groupId/read', requireAuth, requireGroupMembership, async (req, res) => {
  await ensureSchema();
  const { groupId } = req.chat;
  const memberId   = req.session.memberId;
  let messageId    = Number(req.body && req.body.messageId) || 0;

  try {
    if (!messageId) {
      const [latestRows] = await pool.execute(
        'SELECT MAX(id) AS lastId FROM messages WHERE group_id = ?',
        [groupId]
      );
      messageId = Number(latestRows[0] && latestRows[0].lastId) || 0;
    }
    await pool.execute(
      `INSERT INTO group_member_reads (member_id, group_id, last_read_message_id)
       VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE
         last_read_message_id = GREATEST(last_read_message_id, VALUES(last_read_message_id))`,
      [memberId, groupId, messageId]
    );
    res.json({ ok: true, lastReadMessageId: messageId });
  } catch (e) {
    console.error('[chat] mark-read failed:', e);
    res.status(500).json({ error: '읽음 처리에 실패했습니다.' });
  }
});

// ── External notification API ──────────────────────────────
//
// Other routers (community, auth) call these to surface real
// group-membership changes — distinct from chat-window toggles —
// to anyone currently subscribed to the group's SSE stream.

function notifyMemberJoined(groupId, info) {
  const id = Number(groupId);
  if (!id) return;
  broadcastToGroup(id, 'member_change', {
    type: 'joined',
    memberId: info && info.memberId,
    nickname: info && info.nickname,
  });
}

function notifyMemberLeft(groupId, info) {
  const id = Number(groupId);
  if (!id) return;
  broadcastToGroup(id, 'member_change', {
    type: 'left',
    memberId: info && info.memberId,
    nickname: info && info.nickname,
  });
}

// Force-close every SSE connection belonging to this member, across all
// groups. Used on logout so the user disappears from the presence grid
// immediately instead of lingering until the browser tab closes.
function kickMember(memberId) {
  const target = Number(memberId);
  if (!target) return;
  for (const map of groupClients.values()) {
    for (const [res, info] of map) {
      if (info.memberId === target) {
        try { res.end(); } catch (_) { /* ignore */ }
        // The req.on('close') handler in handleStream will remove the entry
        // from the map and broadcast a fresh presence snapshot.
      }
    }
  }
}

module.exports = router;
module.exports.notifyMemberJoined = notifyMemberJoined;
module.exports.notifyMemberLeft   = notifyMemberLeft;
module.exports.kickMember         = kickMember;
