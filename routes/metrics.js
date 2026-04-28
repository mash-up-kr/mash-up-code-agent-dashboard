'use strict';

const { Router } = require('express');
const crypto     = require('crypto');
const { pool }   = require('../db');

const router = Router();

// 서버 메모리: 멤버별 실시간 현황
const memberMetrics = new Map();

// SSE 클라이언트: groupId -> Set<res>
const groupClients = new Map();

const ONLINE_THRESHOLD_MS = 5 * 60 * 1000; // 5분
const ACTIVITY_WINDOW_MINUTES = 60;

function isOnline(metrics) {
  if (!metrics?.lastActiveAt) return false;
  return Date.now() - new Date(metrics.lastActiveAt).getTime() < ONLINE_THRESHOLD_MS;
}

function getMetrics(memberId) {
  return memberMetrics.get(memberId) ?? {
    lastActiveAt:   null,
    toolCallCount:  0,
    sessionCount:   0,
    cwd:            null,
    activityByMinute: {},
  };
}

function extractProject(cwd) {
  if (!cwd) return null;
  return cwd.split('/').filter(Boolean).pop() || null;
}

function minuteBucketKey(ts = Date.now()) {
  return Math.floor(ts / 60000);
}

function pruneActivityBuckets(activityByMinute, nowBucket = minuteBucketKey()) {
  const next = {};
  const minBucket = nowBucket - ACTIVITY_WINDOW_MINUTES + 1;
  for (const [bucket, count] of Object.entries(activityByMinute || {})) {
    const n = Number(bucket);
    if (n >= minBucket && n <= nowBucket && count > 0) next[n] = count;
  }
  return next;
}

function buildRealtimeActivity(metrics, nowBucket = minuteBucketKey()) {
  const pruned = pruneActivityBuckets(metrics?.activityByMinute, nowBucket);
  if (metrics) metrics.activityByMinute = pruned;

  const buckets = [];
  for (let i = ACTIVITY_WINDOW_MINUTES - 1; i >= 0; i--) {
    const bucket = nowBucket - i;
    buckets.push(pruned[bucket] || 0);
  }
  return buckets;
}

// 특정 그룹의 전체 SSE 클라이언트에게 멤버 현황 브로드캐스트
async function broadcastGroupUpdate(groupId) {
  const clients = groupClients.get(groupId);
  if (!clients || clients.size === 0) return;

  const [rows] = await pool.execute(`
    SELECT m.id, m.name, gm.nickname, gm.is_creator
    FROM group_members gm
    JOIN members m ON m.id = gm.member_id
    WHERE gm.group_id = ?
    ORDER BY gm.joined_at ASC
  `, [groupId]);

  const nowBucket = minuteBucketKey();

  const members = rows.map(r => {
    const metrics = getMetrics(r.id);
    return {
      memberId:      r.id,
      name:          r.name,
      nickname:      r.nickname,
      isCreator:     Boolean(r.is_creator),
      isOnline:      isOnline(metrics),
      lastActiveAt:  metrics.lastActiveAt,
      toolCallCount: metrics.toolCallCount,
      sessionCount:  metrics.sessionCount,
      cwd:           metrics.cwd,
      activity:      buildRealtimeActivity(metrics, nowBucket),
    };
  });

  const msg = `data: ${JSON.stringify(members)}\n\n`;
  for (const res of [...clients]) {
    try { res.write(msg); } catch (_) { clients.delete(res); }
  }
}

// 오프라인 전환 감지 + 60분 롤링 창 갱신
const prevOnlineStatus = new Map();

setInterval(async () => {
  const changedGroups = new Set();

  for (const [memberId, metrics] of memberMetrics) {
    const prev = prevOnlineStatus.get(memberId);
    const curr = isOnline(metrics);
    if (prev !== curr) {
      prevOnlineStatus.set(memberId, curr);
      try {
        const [rows] = await pool.execute(
          'SELECT group_id FROM group_members WHERE member_id = ?',
          [memberId]
        );
        for (const { group_id } of rows) changedGroups.add(group_id);
      } catch (_) {}
    }
  }

  for (const groupId of groupClients.keys()) changedGroups.add(groupId);

  for (const groupId of changedGroups) {
    broadcastGroupUpdate(groupId).catch(() => {});
  }
}, 60 * 1000);

// ── 훅 토큰 발급 ─────────────────────────────────────
router.get('/token', async (req, res) => {
  if (!req.session.memberId) return res.status(401).json({ error: '로그인이 필요합니다.' });

  const [rows] = await pool.execute('SELECT hook_token FROM members WHERE id = ?', [req.session.memberId]);
  let token = rows[0]?.hook_token;

  if (!token) {
    token = crypto.randomBytes(32).toString('hex');
    await pool.execute('UPDATE members SET hook_token = ? WHERE id = ?', [token, req.session.memberId]);
  }

  res.json({ token });
});

// ── 훅 데이터 수신 ────────────────────────────────────
router.post('/', async (req, res) => {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return res.status(401).json({ error: '토큰이 필요합니다.' });

  const [rows] = await pool.execute('SELECT id FROM members WHERE hook_token = ?', [token]);
  if (rows.length === 0) return res.status(401).json({ error: '유효하지 않은 토큰입니다.' });

  const memberId = rows[0].id;
  const { hook_event_name, tool_name, cwd, session_id } = req.body;

  const cur = memberMetrics.get(memberId) ?? { toolCallCount: 0, sessionCount: 0 };
  const updated = {
    ...cur,
    lastActiveAt: new Date().toISOString(),
    cwd:          cwd || cur.cwd,
    activityByMinute: pruneActivityBuckets(cur.activityByMinute),
  };
  if (hook_event_name === 'PostToolUse') {
    updated.toolCallCount = (cur.toolCallCount || 0) + 1;
    const bucket = minuteBucketKey();
    updated.activityByMinute[bucket] = (updated.activityByMinute[bucket] || 0) + 1;
  }
  if (hook_event_name === 'Stop')        updated.sessionCount  = (cur.sessionCount  || 0) + 1;
  memberMetrics.set(memberId, updated);
  prevOnlineStatus.set(memberId, true);

  // DB 저장
  if (hook_event_name === 'PostToolUse' || hook_event_name === 'Stop') {
    const projectName = extractProject(cwd);
    await pool.execute(
      'INSERT INTO member_events (member_id, session_id, hook_event, tool_name, cwd, project_name) VALUES (?, ?, ?, ?, ?, ?)',
      [memberId, session_id || null, hook_event_name, tool_name || null, cwd || null, projectName]
    ).catch(e => console.error('metrics insert error:', e));
  }

  // 해당 멤버가 속한 그룹들에 SSE 브로드캐스트
  const [groupRows] = await pool.execute(
    'SELECT group_id FROM group_members WHERE member_id = ?',
    [memberId]
  );
  for (const { group_id } of groupRows) {
    broadcastGroupUpdate(group_id).catch(() => {});
  }

  res.json({ ok: true });
});

// ── 그룹 멤버 실시간 SSE 스트림 ──────────────────────
router.get('/groups/:groupId/sse', async (req, res) => {
  if (!req.session.memberId) return res.status(401).json({ error: '로그인이 필요합니다.' });

  const groupId = Number(req.params.groupId);

  const [membership] = await pool.execute(
    'SELECT id FROM group_members WHERE group_id = ? AND member_id = ?',
    [groupId, req.session.memberId]
  );
  if (membership.length === 0) return res.status(403).json({ error: '그룹 멤버가 아닙니다.' });

  res.writeHead(200, {
    'Content-Type':  'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection':    'keep-alive',
  });
  res.write('event: connected\ndata: {}\n\n');

  if (!groupClients.has(groupId)) groupClients.set(groupId, new Set());
  groupClients.get(groupId).add(res);

  // 접속 즉시 현재 상태 전송
  broadcastGroupUpdate(groupId).catch(() => {});

  req.on('close', () => {
    const clients = groupClients.get(groupId);
    if (clients) {
      clients.delete(res);
      if (clients.size === 0) groupClients.delete(groupId);
    }
  });
});

// ── 그룹 멤버 목록 (REST fallback) ───────────────────
router.get('/groups/:groupId/members', async (req, res) => {
  if (!req.session.memberId) return res.status(401).json({ error: '로그인이 필요합니다.' });

  const groupId = Number(req.params.groupId);

  const [rows] = await pool.execute(`
    SELECT m.id, m.name, gm.nickname, gm.is_creator
    FROM group_members gm
    JOIN members m ON m.id = gm.member_id
    WHERE gm.group_id = ?
    ORDER BY gm.joined_at ASC
  `, [groupId]);

  const nowBucket = minuteBucketKey();

  const members = rows.map(r => {
    const metrics = getMetrics(r.id);
    return {
      memberId:      r.id,
      name:          r.name,
      nickname:      r.nickname,
      isCreator:     Boolean(r.is_creator),
      isOnline:      isOnline(metrics),
      lastActiveAt:  metrics.lastActiveAt,
      toolCallCount: metrics.toolCallCount,
      sessionCount:  metrics.sessionCount,
      cwd:           metrics.cwd,
      activity:      buildRealtimeActivity(metrics, nowBucket),
    };
  });

  res.json(members);
});

// ── 멤버 상세 통계 (팝업용) ───────────────────────────
router.get('/members/:memberId/stats', async (req, res) => {
  if (!req.session.memberId) return res.status(401).json({ error: '로그인이 필요합니다.' });

  const memberId = Number(req.params.memberId);
  const metrics  = getMetrics(memberId);
  const online   = isOnline(metrics);

  const [grassRows] = await pool.execute(`
    SELECT DATE_FORMAT(created_at, '%Y-%m-%d') AS date, COUNT(*) AS count
    FROM member_events
    WHERE member_id = ?
      AND created_at >= DATE_SUB(CURDATE(), INTERVAL 6 DAY)
      AND hook_event = 'PostToolUse'
    GROUP BY DATE_FORMAT(created_at, '%Y-%m-%d')
    ORDER BY date ASC
  `, [memberId]);

  const grassMap = new Map(grassRows.map(r => [r.date, Number(r.count)]));
  const grass = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const dateStr = d.toISOString().slice(0, 10);
    grass.push({ date: dateStr, count: grassMap.get(dateStr) ?? 0 });
  }

  const [projectRows] = await pool.execute(`
    SELECT project_name, COUNT(*) AS count
    FROM member_events
    WHERE member_id = ?
      AND created_at >= DATE_SUB(CURDATE(), INTERVAL 7 DAY)
      AND hook_event = 'PostToolUse'
      AND project_name IS NOT NULL
    GROUP BY project_name
    ORDER BY count DESC
    LIMIT 5
  `, [memberId]);

  res.json({
    isOnline:      online,
    lastActiveAt:  metrics.lastActiveAt,
    toolCallCount: metrics.toolCallCount,
    sessionCount:  metrics.sessionCount,
    cwd:           metrics.cwd,
    grass,
    topProjects: projectRows.map(r => ({
      name:  r.project_name,
      count: Number(r.count),
    })),
  });
});

module.exports = { router, memberMetrics };
