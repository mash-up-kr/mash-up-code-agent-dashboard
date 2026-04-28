'use strict';

const { Router } = require('express');
const crypto     = require('crypto');
const { pool }   = require('../db');

const router = Router();

// 서버 메모리: 멤버별 실시간 현황
// { memberId: { lastActiveAt, toolCallCount, sessionCount, cwd, isOnline } }
const memberMetrics = new Map();

const ONLINE_THRESHOLD_MS = 5 * 60 * 1000; // 5분

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
    isOnline:       false,
  };
}

// cwd에서 프로젝트명 추출 (마지막 디렉토리명)
function extractProject(cwd) {
  if (!cwd) return null;
  return cwd.split('/').filter(Boolean).pop() || null;
}

// ── 훅 토큰 발급 ─────────────────────────────────────
// GET /api/metrics/token — 내 훅 토큰 조회 (없으면 생성)
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
// POST /api/metrics — Claude Code 훅에서 호출 (Bearer 토큰 인증)
router.post('/', async (req, res) => {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return res.status(401).json({ error: '토큰이 필요합니다.' });

  const [rows] = await pool.execute('SELECT id FROM members WHERE hook_token = ?', [token]);
  if (rows.length === 0) return res.status(401).json({ error: '유효하지 않은 토큰입니다.' });

  const memberId   = rows[0].id;
  const { hook_event_name, tool_name, cwd, session_id } = req.body;

  // 메모리 업데이트
  const cur = memberMetrics.get(memberId) ?? { toolCallCount: 0, sessionCount: 0 };
  const updated = {
    ...cur,
    lastActiveAt: new Date().toISOString(),
    cwd:          cwd || cur.cwd,
  };
  if (hook_event_name === 'PostToolUse') updated.toolCallCount = (cur.toolCallCount || 0) + 1;
  if (hook_event_name === 'Stop')        updated.sessionCount  = (cur.sessionCount  || 0) + 1;
  memberMetrics.set(memberId, updated);

  // DB 저장 (PostToolUse, Stop만)
  if (hook_event_name === 'PostToolUse' || hook_event_name === 'Stop') {
    const projectName = extractProject(cwd);
    await pool.execute(
      'INSERT INTO member_events (member_id, session_id, hook_event, tool_name, cwd, project_name) VALUES (?, ?, ?, ?, ?, ?)',
      [memberId, session_id || null, hook_event_name, tool_name || null, cwd || null, projectName]
    ).catch(e => console.error('metrics insert error:', e));
  }

  res.json({ ok: true });
});

// ── 그룹 멤버 실시간 현황 ─────────────────────────────
// GET /api/metrics/groups/:groupId/members — 그룹 멤버 + 실시간 지표
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
    };
  });

  res.json(members);
});

// ── 멤버 상세 통계 (팝업용) ───────────────────────────
// GET /api/metrics/members/:memberId/stats
router.get('/members/:memberId/stats', async (req, res) => {
  if (!req.session.memberId) return res.status(401).json({ error: '로그인이 필요합니다.' });

  const memberId = Number(req.params.memberId);

  // 온라인 여부 (메모리)
  const metrics = getMetrics(memberId);
  const online  = isOnline(metrics);

  // 잔디: 최근 7일 날짜별 이벤트 수
  const [grassRows] = await pool.execute(`
    SELECT DATE_FORMAT(created_at, '%Y-%m-%d') AS date, COUNT(*) AS count
    FROM member_events
    WHERE member_id = ?
      AND created_at >= DATE_SUB(CURDATE(), INTERVAL 6 DAY)
      AND hook_event = 'PostToolUse'
    GROUP BY DATE_FORMAT(created_at, '%Y-%m-%d')
    ORDER BY date ASC
  `, [memberId]);

  // 잔디 데이터를 7일치 배열로 (빈 날짜는 0)
  const grassMap = new Map(grassRows.map(r => [r.date, Number(r.count)]));
  const grass = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const dateStr = d.toISOString().slice(0, 10);
    grass.push({ date: dateStr, count: grassMap.get(dateStr) ?? 0 });
  }

  // 프로젝트 순위: 이번 주 프로젝트별 툴 호출 수
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
