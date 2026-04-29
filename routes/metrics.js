'use strict';

const { Router } = require('express');
const crypto     = require('crypto');
const { pool }   = require('../db');

const router = Router();

// 서버 메모리: 멤버별 실시간 현황
const memberMetrics = new Map();

// SSE 클라이언트: groupId -> Set<res>
const groupClients = new Map();

const ONLINE_THRESHOLD_MS = 5 * 60 * 1000;  // 5분
const SESSION_TIMEOUT_MS  = 5 * 60 * 1000;  // 5분
const BUCKET_SIZE_MS = 60 * 1000;           // 1분 단위
const ACTIVITY_WINDOW_BUCKETS = 60;         // 60 × 1분 = 60분 (토큰 합산)

function isOnline(metrics) {
  if (!metrics?.lastActiveAt) return false;
  return Date.now() - new Date(metrics.lastActiveAt).getTime() < ONLINE_THRESHOLD_MS;
}

function getMetrics(memberId) {
  return memberMetrics.get(memberId) ?? {
    lastActiveAt:      null,
    toolCallCount:     0,
    sessionCount:      0,
    cwd:               null,
    activityBySession: {}, // { [session_id]: { project: string, buckets: { [bucket]: tokens } } }
    recentTokenEvents: [], // [{ sessionId, project, hookEventName, tokens, ts }]
    activeSessions:    new Map(), // session_id → { ts, cwd }
    seenSessions:      new Set(),
  };
}

function countActiveSessions(activeSessions) {
  const cutoff = Date.now() - SESSION_TIMEOUT_MS;
  return [...activeSessions.values()].filter(({ ts }) => ts > cutoff).length;
}

function getActiveProjects(activeSessions) {
  const cutoff = Date.now() - SESSION_TIMEOUT_MS;
  const projects = new Set();
  for (const { ts, cwd } of activeSessions.values()) {
    if (ts > cutoff && cwd) projects.add(extractProject(cwd));
  }
  return [...projects].filter(Boolean);
}

function getActiveSessionIds(activeSessions, now = Date.now()) {
  const cutoff = now - SESSION_TIMEOUT_MS;
  return new Set(
    [...(activeSessions || new Map()).entries()]
      .filter(([, { ts }]) => ts > cutoff)
      .map(([sid]) => sid)
  );
}

function extractProject(cwd) {
  if (!cwd) return null;
  return cwd.split('/').filter(Boolean).pop() || null;
}

function minuteBucketKey(ts = Date.now()) {
  return Math.floor(ts / BUCKET_SIZE_MS);
}

function pruneSessionActivities(activityBySession, nowBucket = minuteBucketKey()) {
  const minBucket = nowBucket - ACTIVITY_WINDOW_BUCKETS + 1;
  const next = {};
  for (const [sid, entry] of Object.entries(activityBySession || {})) {
    const prunedBuckets = {};
    for (const [b, tokens] of Object.entries(entry.buckets || {})) {
      const n = Number(b);
      if (n >= minBucket && n <= nowBucket && tokens > 0) prunedBuckets[n] = tokens;
    }
    if (Object.keys(prunedBuckets).length > 0) {
      next[sid] = { project: entry.project, buckets: prunedBuckets };
    }
  }
  return next;
}

function pruneRecentTokenEvents(events, now = Date.now()) {
  const cutoff = now - (ACTIVITY_WINDOW_BUCKETS * BUCKET_SIZE_MS);
  return (events || []).filter((event) => {
    const ts = new Date(event.ts).getTime();
    return Number.isFinite(ts) && ts >= cutoff;
  }).slice(-24);
}

function buildSessionActivities(metrics, nowBucket = minuteBucketKey(), options = {}) {
  const pruned = pruneSessionActivities(metrics?.activityBySession, nowBucket);
  if (metrics) metrics.activityBySession = pruned;
  const activeSessionIds = options.activeOnly
    ? getActiveSessionIds(metrics?.activeSessions, nowBucket * BUCKET_SIZE_MS)
    : null;

  // 같은 프로젝트의 여러 세션은 토큰을 합산해서 하나의 라인으로
  const byProject = new Map();
  for (const [sid, entry] of Object.entries(pruned)) {
    if (activeSessionIds && !activeSessionIds.has(sid)) continue;
    const tokens = [];
    for (let i = ACTIVITY_WINDOW_BUCKETS - 1; i >= 0; i--) {
      tokens.push(entry.buckets[nowBucket - i] || 0);
    }
    if (byProject.has(entry.project)) {
      const existing = byProject.get(entry.project);
      byProject.set(entry.project, existing.map((v, i) => v + tokens[i]));
    } else {
      byProject.set(entry.project, tokens);
    }
  }

  return [...byProject.entries()].map(([project, tokens]) => ({ project, tokens }));
}

function serializeGroupMembers(rows, nowBucket = minuteBucketKey()) {
  return rows.map(r => {
    const metrics = getMetrics(r.id);
    return {
      memberId:           r.id,
      name:               r.name,
      nickname:           r.nickname,
      isCreator:          Boolean(r.is_creator),
      isOnline:           isOnline(metrics),
      lastActiveAt:       metrics.lastActiveAt,
      toolCallCount:      metrics.toolCallCount,
      sessionCount:       metrics.sessionCount,
      activeSessionCount: countActiveSessions(metrics.activeSessions ?? new Map()),
      activeProjects:     getActiveProjects(metrics.activeSessions ?? new Map()),
      cwd:                metrics.cwd,
      sessionActivity:    buildSessionActivities(metrics, nowBucket, { activeOnly: true }),
    };
  });
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
  const members = serializeGroupMembers(rows, nowBucket);

  const msg = `data: ${JSON.stringify(members)}\n\n`;
  for (const res of [...clients]) {
    try { res.write(msg); } catch (_) { clients.delete(res); }
  }
}

// 오프라인 전환 감지 + 10분 롤링 창 갱신
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
  const { hook_event_name, tool_name, cwd, session_id, output_tokens, input_tokens } = req.body;

  const cur = memberMetrics.get(memberId) ?? { toolCallCount: 0, sessionCount: 0 };
  const updated = {
    ...cur,
    lastActiveAt:      new Date().toISOString(),
    cwd:               cwd || cur.cwd,
    activityBySession: pruneSessionActivities(cur.activityBySession ?? {}),
    recentTokenEvents: pruneRecentTokenEvents(cur.recentTokenEvents ?? []),
    seenSessions:      cur.seenSessions  ?? new Set(),
    activeSessions:    cur.activeSessions ?? new Map(),
  };
  if (session_id) {
    if (hook_event_name === 'SessionStart') {
      updated.activeSessions.set(session_id, { ts: Date.now(), cwd: cwd || cur.cwd });
    } else if (hook_event_name === 'SessionEnd') {
      updated.activeSessions.delete(session_id);
    } else {
      // 그 외 훅은 기존 세션 ts·cwd 갱신 (없으면 신규 등록)
      updated.activeSessions.set(session_id, { ts: Date.now(), cwd: cwd || cur.cwd });
    }
  }
  if (hook_event_name === 'PostToolUse') {
    updated.toolCallCount = (cur.toolCallCount || 0) + 1;
  }
  if (hook_event_name === 'Stop') {
    const inputTokens = Number(input_tokens) || 0;
    const outputTokens = Number(output_tokens) || 0;
    const tokens = inputTokens + outputTokens;
    console.log(
      `[metrics] Stop event memberId=${memberId} session=${session_id} input_tokens=${input_tokens} output_tokens=${output_tokens} parsed=${tokens}`
    );
    if (tokens > 0 && session_id) {
      const bucket = minuteBucketKey();
      const project = extractProject(cwd || cur.cwd) || session_id.slice(0, 8);
      if (!updated.activityBySession[session_id]) {
        updated.activityBySession[session_id] = { project, buckets: {} };
      }
      updated.activityBySession[session_id].buckets[bucket] =
          (updated.activityBySession[session_id].buckets[bucket] || 0) + tokens;
      updated.recentTokenEvents.push({
        sessionId: session_id,
        project,
        hookEventName: hook_event_name,
        tokens,
        ts: new Date().toISOString(),
      });
      updated.recentTokenEvents = pruneRecentTokenEvents(updated.recentTokenEvents);
    }
  }
  if (hook_event_name === 'Stop' && session_id && !updated.seenSessions.has(session_id)) {
    updated.seenSessions.add(session_id);
    updated.sessionCount = (cur.sessionCount || 0) + 1;
  }
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
  const members = serializeGroupMembers(rows, nowBucket);

  res.json(members);
});

// ── 멤버 상세 통계 (팝업용) ───────────────────────────
router.get('/members/:memberId/stats', async (req, res) => {
  if (!req.session.memberId) return res.status(401).json({ error: '로그인이 필요합니다.' });

  const memberId = Number(req.params.memberId);
  const metrics  = getMetrics(memberId);
  const online   = isOnline(metrics);
  const nowBucket = minuteBucketKey();
  const projectSeries = buildSessionActivities(metrics, nowBucket);
  const recentTokenEvents = pruneRecentTokenEvents(metrics.recentTokenEvents ?? []);

  res.json({
    isOnline:      online,
    lastActiveAt:  metrics.lastActiveAt,
    toolCallCount: metrics.toolCallCount,
    sessionCount:  metrics.sessionCount,
    cwd:           metrics.cwd,
    projectSeries,
    recentTokenEvents,
  });
});

module.exports = { router, memberMetrics };
