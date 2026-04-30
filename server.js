#!/usr/bin/env node
'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');
require('dotenv').config();
require('dotenv').config({ path: path.join(__dirname, '.env.local'), override: true });
const {
  router: usageRouter,
  init: initUsage,
  updateRateLimits,
  setBroadcast: setUsageBroadcast,
  getUsageState,
} = require('./routes/usage');

// 커뮤니티/인증/채팅은 선택 의존성 — MySQL 미설치 시에도 JSONL/세션 시각화는 동작한다.
let session = null;
let initDB = null;
let communityRouter = null;
let authRouter = null;
let chatRouter = null;
let metricsRouter = null;
let communityModulesLoaded = false;
try {
  session         = require('express-session');
  ({ initDB }     = require('./db'));
  communityRouter = require('./routes/community');
  authRouter      = require('./routes/auth');
  chatRouter      = require('./routes/chat');
  metricsRouter   = require('./routes/metrics').router;
  communityModulesLoaded = true;
} catch (err) {
  console.warn(`[community] 의존성 미설치 — 커뮤니티/인증/채팅 모듈 비활성화: ${err.message}`);
  console.warn('  npm run install:community 로 활성화할 수 있어요.');
}

const app = express();
const PORT = process.env.AGENT_VIZ_PORT || 4321;
const DATA_DIR = path.join(__dirname, 'data');
const DEFAULT_COMMUNITY_API_URL = 'http://223.130.141.52:4321';
const COMMUNITY_API_URL = process.env.COMMUNITY_API_URL || DEFAULT_COMMUNITY_API_URL;

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// In-memory state
const sessions = new Map(); // pid -> session object
const events = [];          // recent events (max 200)
const clients = new Set();  // SSE clients

// Per-session accumulated stats (for persistence)
const sessionStats = new Map(); // pid -> { toolCounts, modifiedFiles, eventCount, thinkingStartTs }

// ── Inactivity reaper ───────────────────────────
const INACTIVE_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

setInterval(() => {
  const now = Date.now();
  for (const [pid, sess] of sessions) {
    if (sess.status === 'ended') continue;
    if (sess.lastActivityAt && now - sess.lastActivityAt > INACTIVE_TIMEOUT_MS) {
      sess.status = 'ended';
      sess.endedAt = now;
      const stats = getSessionStats(pid);
      saveSession(pid);
      broadcast('notification', {
        type: 'session_end',
        title: '세션 타임아웃',
        message: `${sess.name} 세션이 비활성으로 종료되었습니다 (${stats.eventCount} events)`,
        ts: now,
      });
      broadcast('session', sess);
      setTimeout(() => sessions.delete(pid), 3000);
    }
  }
}, 5000);

function getSessionStats(pid) {
  if (!sessionStats.has(pid)) {
    let existing = null;
    try {
      const filePath = sessionFileName(pid);
      if (fs.existsSync(filePath)) {
        existing = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      }
    } catch (_) { /* ignore */ }

    sessionStats.set(pid, {
      toolCounts: existing?.toolCounts || {},
      modifiedFiles: existing?.modifiedFiles || {},
      hourlyActivity: existing?.hourlyActivity || {},
      bashCommands: existing?.bashCommands || [],
      tasks: existing?.tasks || [],
      eventCount: existing?.eventCount || 0,
      thinkingStartTs: null,
      thinkingDuration: existing?.thinkingDuration || 0,
    });
  }
  return sessionStats.get(pid);
}

function broadcast(eventName, data) {
  const msg = `event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) {
    try { res.write(msg); } catch (_) { clients.delete(res); }
  }
}
setUsageBroadcast(broadcast);

function addEvent(entry) {
  events.push(entry);
  if (events.length > 200) events.shift();
  broadcast('event', entry);
}

function shouldProxyCommunityApi() {
  if (!COMMUNITY_API_URL) return false;
  try {
    const target = new URL(COMMUNITY_API_URL);
    return !['localhost', '127.0.0.1', '::1'].includes(target.hostname);
  } catch (_) {
    return false;
  }
}

async function proxyCommunityRequest(req, res) {
  const targetUrl = new URL(req.originalUrl, COMMUNITY_API_URL);
  const headers = {};
  for (const [key, value] of Object.entries(req.headers)) {
    const lower = key.toLowerCase();
    if (['host', 'connection', 'content-length'].includes(lower)) continue;
    headers[key] = value;
  }

  const init = {
    method: req.method,
    headers,
    redirect: 'manual',
  };
  if (!['GET', 'HEAD'].includes(req.method)) {
    init.body = req.is('application/json') ? JSON.stringify(req.body ?? {}) : req.body;
  }

  try {
    const upstream = await fetch(targetUrl, init);
    res.status(upstream.status);
    upstream.headers.forEach((value, key) => {
      const lower = key.toLowerCase();
      if (['content-encoding', 'content-length', 'transfer-encoding'].includes(lower)) return;
      if (lower === 'set-cookie') {
        res.append('Set-Cookie', value);
      } else {
        res.setHeader(key, value);
      }
    });

    if (!upstream.body) return res.end();
    Readable.fromWeb(upstream.body).pipe(res);
  } catch (err) {
    res.status(502).json({
      error: 'community_proxy_failed',
      message: '커뮤니티 서버에 연결하지 못했습니다.',
    });
  }
}

function getToolDetail(toolName, input) {
  if (!input) return '';
  switch (toolName) {
    case 'Bash':        return input.command ? input.command.slice(0, 120) : '';
    case 'Read':        return input.file_path || '';
    case 'Write':       return input.file_path || '';
    case 'Edit':        return input.file_path || '';
    case 'Grep':        return input.pattern ? `${input.pattern}${input.path ? '  ' + input.path : ''}` : '';
    case 'Glob':        return input.pattern || '';
    case 'WebFetch':    return input.url || '';
    case 'WebSearch':   return input.query || '';
    case 'Agent':       return input.description || input.prompt?.slice(0, 80) || '';
    case 'TodoWrite':   return (input.todos || []).map(t => t.content).join(', ').slice(0, 100);
    case 'TaskCreate':  return input.subject || input.description?.slice(0, 60) || '';
    case 'TaskUpdate':  return input.status ? `#${input.taskId || '?'} → ${input.status}` : `#${input.taskId || '?'}`;
    case 'ToolSearch':  return input.query || '';
    default:            return JSON.stringify(input).slice(0, 100);
  }
}

// ── Persistence ──────────────────────────────────

function sessionFileName(pid) {
  const safe = String(pid).replace(/[^a-zA-Z0-9_-]/g, '_');
  return path.join(DATA_DIR, `session_${safe}.json`);
}

function saveSession(pid) {
  const sess = sessions.get(pid);
  if (!sess) return;
  const stats = getSessionStats(pid);
  const record = {
    pid: sess.pid,
    cwd: sess.cwd,
    sid: sess.sid,
    name: sess.name,
    startedAt: sess.startedAt,
    endedAt: sess.endedAt || null,
    lastActivityAt: sess.lastActivityAt || null,
    status: sess.status,
    toolCounts: stats.toolCounts,
    modifiedFiles: stats.modifiedFiles,
    hourlyActivity: stats.hourlyActivity,
    bashCommands: stats.bashCommands,
    tasks: stats.tasks || [],
    eventCount: stats.eventCount,
    thinkingDuration: stats.thinkingDuration,
  };
  try {
    fs.writeFileSync(sessionFileName(pid), JSON.stringify(record, null, 2));
  } catch (_) { /* ignore write errors */ }
}

function tokenizePiece(cmd) {
  if (!cmd) return [];
  const tokens = [];
  let cur = '';
  let q = null;
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    const nx = cmd[i + 1];
    if (q === '"') {
      if (ch === '\\' && (nx === '"' || nx === '\\' || nx === '$' || nx === '`')) { cur += ch + nx; i++; continue; }
      if (ch === '"') { q = null; cur += ch; continue; }
      cur += ch; continue;
    }
    if (q === "'") {
      if (ch === "'") { q = null; cur += ch; continue; }
      cur += ch; continue;
    }
    if (ch === '\\') { cur += ch + (nx || ''); i++; continue; }
    if (ch === '"' || ch === "'") { q = ch; cur += ch; continue; }
    if (ch === ' ' || ch === '\t') {
      if (cur) { tokens.push(cur); cur = ''; }
      continue;
    }
    cur += ch;
  }
  if (cur) tokens.push(cur);
  return tokens;
}

const SUBCOMMAND_HOSTS = /^(git|npm|npx|yarn|pnpm|docker|kubectl|cargo|go|helm|bun|terraform|brew|apt|apt-get|systemctl|pm2)$/;

function normalizeKey(piece) {
  const tokens = tokenizePiece(piece);
  if (tokens.length === 0) return '';
  let idx = 0;
  while (idx < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[idx])) idx++;
  if (idx >= tokens.length) return tokens[0];
  const cmd = tokens[idx];
  if (idx + 1 < tokens.length && SUBCOMMAND_HOSTS.test(cmd) && !tokens[idx + 1].startsWith('-')) {
    return cmd + ' ' + tokens[idx + 1];
  }
  return cmd;
}

const COMBINED_SHORT_FLAGS_CMDS = new Set([
  'ls', 'grep', 'egrep', 'fgrep', 'zgrep', 'tar', 'ps', 'chmod', 'chown',
  'cp', 'mv', 'rm', 'mkdir', 'cat', 'head', 'tail', 'sort', 'uniq',
  'wc', 'cut', 'tr', 'du', 'df', 'date', 'touch', 'ln', 'tee', 'diff',
]);

function splitShortFlags(flag, cmd) {
  if (!flag || !flag.startsWith('-') || flag === '-' || flag === '--') return [flag];
  if (flag.startsWith('--')) return [flag.split('=')[0]];
  const body = flag.slice(1);
  if (COMBINED_SHORT_FLAGS_CMDS.has(cmd) && /^[a-zA-Z]{2,}$/.test(body)) {
    return body.split('').map(c => '-' + c);
  }
  if (COMBINED_SHORT_FLAGS_CMDS.has(cmd)) {
    const m = body.match(/^([a-zA-Z])/);
    if (m && m[1] !== body) return ['-' + m[1]];
  }
  return [flag];
}

function categorizeCmd(cmd) {
  if (/^git\s/.test(cmd)) return 'git';
  if (/^(npm|npx|yarn|pnpm|bun)\s/.test(cmd)) return 'package';
  if (/^(node|python|ruby|java|go|cargo|rustc)\s/.test(cmd)) return 'runtime';
  if (/^(docker|kubectl|helm)\s/.test(cmd)) return 'infra';
  if (/^(ls|cd|pwd|cat|head|tail|mkdir|rm|cp|mv|chmod|chown|find|grep|awk|sed|wc|sort|xargs|tar|zip|unzip|curl|wget)\b/.test(cmd)) return 'shell';
  if (/^(make|cmake|gradle|mvn)\s/.test(cmd)) return 'build';
  if (/test|spec|jest|vitest|pytest|mocha/.test(cmd)) return 'test';
  if (/lint|eslint|prettier|fmt/.test(cmd)) return 'lint';
  return 'other';
}

const SHELL_FRAGMENTS = new Set([
  'do', 'done', 'then', 'fi', 'else', 'elif', 'esac', ';;',
  '{', '}', '(', ')', '[', ']', '[[', ']]',
]);

function splitPipeline(raw) {
  if (!raw) return [];
  const parts = [];
  let cur = '';
  let quote = null;
  let depth = 0;
  const flush = () => {
    const t = cur.trim();
    if (!t) { cur = ''; return; }
    if (t.startsWith('#')) { cur = ''; return; }
    if (SHELL_FRAGMENTS.has(t)) { cur = ''; return; }
    parts.push(t);
    cur = '';
  };
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    const nx = raw[i + 1];

    if (quote === '"') {
      if (ch === '\\' && (nx === '"' || nx === '\\' || nx === '$' || nx === '`' || nx === '\n')) {
        cur += ch + nx; i++; continue;
      }
      if (ch === '"') { quote = null; cur += ch; continue; }
      cur += ch; continue;
    }
    if (quote === "'") {
      if (ch === "'") { quote = null; cur += ch; continue; }
      cur += ch; continue;
    }

    if (ch === '\\') { cur += ch + (nx || ''); i++; continue; }
    if (ch === '"' || ch === "'") { quote = ch; cur += ch; continue; }
    if (ch === '(' || ch === '{') { depth++; cur += ch; continue; }
    if (ch === ')' || ch === '}') { depth--; cur += ch; continue; }
    if (depth > 0) { cur += ch; continue; }
    if ((ch === '&' && nx === '&') || (ch === '|' && (nx === '|' || nx === '&'))) {
      flush(); i++; continue;
    }
    if (ch === '|' || ch === ';' || ch === '\n') {
      flush(); continue;
    }
    cur += ch;
  }
  flush();
  return parts;
}

function loadAllSavedSessions() {
  const results = [];
  try {
    const files = fs.readdirSync(DATA_DIR).filter(f => f.startsWith('session_') && f.endsWith('.json'));
    for (const f of files) {
      try {
        const raw = fs.readFileSync(path.join(DATA_DIR, f), 'utf8');
        results.push(JSON.parse(raw));
      } catch (_) { /* skip corrupt files */ }
    }
  } catch (_) { /* data dir might not exist */ }
  return results;
}

// 서버 재시작 시 endedAt 없이 남아있는 고아 세션을 정리한다.
// 마지막 활동(lastActivityAt)이 INACTIVE_TIMEOUT_MS 이전이면 그 시점에 종료된 것으로 마감한다.
// lastActivityAt이 없는 옛 데이터는 startedAt으로 폴백해 0길이로 봉합한다.
function sweepStaleSessions() {
  const now = Date.now();
  let closed = 0;
  try {
    const files = fs.readdirSync(DATA_DIR).filter(f => f.startsWith('session_') && f.endsWith('.json'));
    for (const f of files) {
      const fp = path.join(DATA_DIR, f);
      let rec;
      try { rec = JSON.parse(fs.readFileSync(fp, 'utf8')); } catch (_) { continue; }
      if (rec.status === 'ended' && rec.endedAt) continue;
      const last = rec.lastActivityAt || rec.startedAt || 0;
      if (!last) continue;
      if (now - last <= INACTIVE_TIMEOUT_MS) continue;
      rec.status = 'ended';
      rec.endedAt = last;
      try { fs.writeFileSync(fp, JSON.stringify(rec, null, 2)); closed++; } catch (_) { /* ignore */ }
    }
  } catch (_) { /* data dir missing */ }
  if (closed > 0) console.log(`[sweep] 고아 세션 ${closed}건을 마감 처리했어요`);
}

// ── Project aggregation ──────────────────────────

function aggregateProjects() {
  const saved = loadAllSavedSessions();
  const byProject = {};
  for (const s of saved) {
    const cwd = s.cwd || 'unknown';
    if (!byProject[cwd]) {
      byProject[cwd] = {
        cwd,
        name: path.basename(cwd) || 'unknown',
        sessions: [],
        totalSessions: 0,
        totalDuration: 0,
        totalEvents: 0,
        totalThinkingDuration: 0,
        toolCounts: {},
        modifiedFiles: {},
        dailyActivity: {},
        hourlyActivity: {},
        lastActivityTs: 0,
        tasks: [],
      };
    }
    const proj = byProject[cwd];

    // 세션의 실제 활성 종료 시각을 결정한다.
    // - status가 ended라면 endedAt을 그대로 사용.
    // - 아직 살아있으면 sessions 맵의 in-memory 정보(가장 신선함)를 우선,
    //   없으면 디스크의 lastActivityAt이 INACTIVE_TIMEOUT_MS 이내일 때만 Date.now()로 인정.
    //   그 외에는 lastActivityAt 시점에 멈춘 것으로 간주해 부풀림을 막는다.
    const live = sessions.get(s.pid);
    const liveLast = live ? live.lastActivityAt : null;
    const diskLast = s.lastActivityAt || null;
    const now = Date.now();
    let effectiveEnd = null;
    if (s.endedAt) {
      effectiveEnd = s.endedAt;
    } else if (liveLast && now - liveLast <= INACTIVE_TIMEOUT_MS) {
      effectiveEnd = now;
    } else if (diskLast && now - diskLast <= INACTIVE_TIMEOUT_MS) {
      effectiveEnd = now;
    } else {
      effectiveEnd = diskLast || s.startedAt || null;
    }

    proj.sessions.push({
      pid: s.pid,
      name: s.name,
      startedAt: s.startedAt,
      endedAt: s.endedAt,
      effectiveEndedAt: effectiveEnd,
      status: s.status,
      eventCount: s.eventCount || 0,
      thinkingDuration: s.thinkingDuration || 0,
    });
    proj.totalSessions++;
    proj.totalEvents += (s.eventCount || 0);
    proj.totalThinkingDuration += (s.thinkingDuration || 0);

    const lastTs = s.endedAt || diskLast || s.startedAt || 0;
    if (lastTs > proj.lastActivityTs) proj.lastActivityTs = lastTs;

    if (s.startedAt && effectiveEnd && effectiveEnd > s.startedAt) {
      proj.totalDuration += (effectiveEnd - s.startedAt);
    }

    for (const [tool, count] of Object.entries(s.toolCounts || {})) {
      proj.toolCounts[tool] = (proj.toolCounts[tool] || 0) + count;
    }

    for (const [file, count] of Object.entries(s.modifiedFiles || {})) {
      proj.modifiedFiles[file] = (proj.modifiedFiles[file] || 0) + count;
    }

    if (s.startedAt) {
      const day = new Date(s.startedAt).toISOString().slice(0, 10);
      proj.dailyActivity[day] = (proj.dailyActivity[day] || 0) + (s.eventCount || 0);
    }

    for (const [hour, count] of Object.entries(s.hourlyActivity || {})) {
      proj.hourlyActivity[hour] = (proj.hourlyActivity[hour] || 0) + count;
    }

    for (const t of (s.tasks || [])) {
      proj.tasks.push({ ...t, sessionName: s.name, sessionPid: s.pid });
    }
  }

  for (const proj of Object.values(byProject)) {
    proj.sessions.sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
    proj.sessions = proj.sessions.slice(0, 20);

    const fileEntries = Object.entries(proj.modifiedFiles)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10);
    proj.topFiles = fileEntries.map(([file, count]) => ({ file, count }));
    delete proj.modifiedFiles;

    const taskMap = new Map();
    for (const t of proj.tasks) {
      const key = t.subject.trim().toLowerCase();
      const existing = taskMap.get(key);
      if (!existing) {
        taskMap.set(key, t);
      } else {
        const statusRank = { completed: 3, in_progress: 2, pending: 1 };
        const eRank = statusRank[existing.status] || 0;
        const tRank = statusRank[t.status] || 0;
        if (tRank > eRank || (tRank === eRank && (t.createdAt || 0) > (existing.createdAt || 0))) {
          taskMap.set(key, t);
        }
      }
    }
    proj.tasks = [...taskMap.values()];

    const archiveCutoff = Date.now() - 24 * 60 * 60 * 1000;
    proj.archivedTaskCount = 0;
    proj.tasks = proj.tasks.filter(t => {
      if (t.status === 'completed' && (t.createdAt || 0) < archiveCutoff) {
        proj.archivedTaskCount++;
        return false;
      }
      return true;
    });

    const statusOrder = { in_progress: 0, pending: 1, completed: 2 };
    proj.tasks.sort((a, b) => {
      const oa = statusOrder[a.status] ?? 1, ob = statusOrder[b.status] ?? 1;
      if (oa !== ob) return oa - ob;
      return (b.createdAt || 0) - (a.createdAt || 0);
    });
    proj.tasks = proj.tasks.slice(0, 30);
  }

  return Object.values(byProject).sort((a, b) => {
    const aLatest = a.sessions[0]?.startedAt || 0;
    const bLatest = b.sessions[0]?.startedAt || 0;
    return bLatest - aLatest;
  });
}

// ── Event handling ───────────────────────────────

function handleEvent(body) {
  const { event: type, session = {}, data = {} } = body;
  const { pid, cwd, name, sid } = session;
  const ts = Date.now();

  const entry = { type, pid, cwd, name, sid, ts };

  if (type === 'statusline_update' || data?.rate_limits) {
    updateRateLimits(data?.rate_limits || {});
    return;
  }

  if (pid && !sessions.has(pid) && type !== 'session_end') {
    let savedStartedAt = null;
    try {
      const fp = sessionFileName(pid);
      if (fs.existsSync(fp)) {
        savedStartedAt = JSON.parse(fs.readFileSync(fp, 'utf8')).startedAt;
      }
    } catch (_) { /* ignore */ }
    sessions.set(pid, {
      pid, cwd, sid,
      name: name || path.basename(cwd || '') || 'unknown',
      status: 'idle',
      startedAt: savedStartedAt || ts,
      endedAt: null,
      lastActivityAt: ts,
    });
  }

  if (pid && sessions.has(pid)) {
    sessions.get(pid).lastActivityAt = ts;
  }

  if (pid) {
    const stats = getSessionStats(pid);
    stats.eventCount++;
    const hour = String(new Date(ts).getHours());
    stats.hourlyActivity[hour] = (stats.hourlyActivity[hour] || 0) + 1;
  }

  switch (type) {
    case 'session_start': {
      let savedStart = null;
      try {
        const fp = sessionFileName(pid);
        if (fs.existsSync(fp)) {
          savedStart = JSON.parse(fs.readFileSync(fp, 'utf8')).startedAt;
        }
      } catch (_) { /* ignore */ }
      sessions.set(pid, {
        pid, cwd, sid,
        name: name || path.basename(cwd || '') || 'unknown',
        status: 'idle',
        startedAt: savedStart || ts,
        endedAt: null,
        lastActivityAt: ts,
      });
      saveSession(pid);
      break;
    }
    case 'session_end':
      if (sessions.has(pid)) {
        const sess = sessions.get(pid);
        sess.status = 'ended';
        sess.endedAt = ts;
        const stats = getSessionStats(pid);
        saveSession(pid);
        broadcast('notification', {
          type: 'session_end',
          title: '세션 완료',
          message: `${sess.name} 세션이 종료되었습니다 (${stats.eventCount} events)`,
          ts,
        });
        setTimeout(() => sessions.delete(pid), 3000);
      }
      break;
    case 'thinking_start':
      if (sessions.has(pid)) sessions.get(pid).status = 'thinking';
      if (pid) getSessionStats(pid).thinkingStartTs = ts;
      break;
    case 'thinking_end':
      if (sessions.has(pid)) sessions.get(pid).status = 'idle';
      if (pid) {
        const stats = getSessionStats(pid);
        if (stats.thinkingStartTs) {
          stats.thinkingDuration += (ts - stats.thinkingStartTs);
          stats.thinkingStartTs = null;
        }
      }
      break;
    case 'stop':
      if (sessions.has(pid)) sessions.get(pid).status = 'idle';
      if (pid) {
        const stats = getSessionStats(pid);
        if (stats.thinkingStartTs) {
          stats.thinkingDuration += (ts - stats.thinkingStartTs);
          stats.thinkingStartTs = null;
        }
      }
      if (sessions.has(pid)) {
        const sess = sessions.get(pid);
        broadcast('notification', {
          type: 'stop',
          title: '응답 완료',
          message: `${sess.name} 세션이 응답을 완료했습니다`,
          ts,
        });
      }
      break;
    case 'agent_start':
      if (sessions.has(pid)) sessions.get(pid).status = 'running';
      entry.agentName = data?.tool_input?.agent_name || '';
      break;
    case 'agent_done':
      if (sessions.has(pid)) sessions.get(pid).status = 'idle';
      break;
    case 'pre_tool_use': {
      const preToolName = data?.tool_name || '';
      entry.toolName = preToolName;
      entry.toolDetail = getToolDetail(preToolName, data?.tool_input);
      if (sessions.has(pid)) {
        const sess = sessions.get(pid);
        if (sess.status === 'idle' || sess.status === 'ended') sess.status = 'running';
      }
      break;
    }
    case 'tool_use': {
      const toolName = data?.tool_name || '';
      entry.toolName = toolName;
      entry.toolDetail = getToolDetail(toolName, data?.tool_input);
      if (sessions.has(pid)) {
        const sess = sessions.get(pid);
        if (sess.status === 'idle' || sess.status === 'ended') sess.status = 'running';
      }

      if (pid) {
        const stats = getSessionStats(pid);
        stats.toolCounts[toolName] = (stats.toolCounts[toolName] || 0) + 1;

        if (['Write', 'Edit'].includes(toolName) && data?.tool_input?.file_path) {
          const filePath = data.tool_input.file_path;
          stats.modifiedFiles[filePath] = (stats.modifiedFiles[filePath] || 0) + 1;
        }

        if (toolName === 'Bash' && data?.tool_input?.command) {
          const cmd = data.tool_input.command.trim();
          if (cmd && stats.bashCommands.length < 500) {
            stats.bashCommands.push({ command: cmd, ts });
          }
        }

        if (toolName === 'TaskCreate' && data?.tool_input?.subject) {
          if (!stats.tasks) stats.tasks = [];
          const newTaskId = String(stats.tasks.length + 1);
          stats.tasks.push({
            taskId: data.tool_result_id || newTaskId,
            subject: data.tool_input.subject,
            description: data.tool_input.description || '',
            status: 'pending',
            createdAt: ts,
          });
          if (stats.tasks.length > 50) {
            const completedIdx = stats.tasks.findIndex(t => t.status === 'completed');
            if (completedIdx !== -1) stats.tasks.splice(completedIdx, 1);
            else stats.tasks.shift();
          }
        }
        if (toolName === 'TaskUpdate' && data?.tool_input) {
          if (!stats.tasks) stats.tasks = [];
          const taskId = data.tool_input.taskId;
          const newStatus = data.tool_input.status;
          if (newStatus && stats.tasks.length > 0) {
            const idx = parseInt(taskId) - 1;
            let matched = false;

            if (idx >= 0 && idx < stats.tasks.length) {
              stats.tasks[idx].status = newStatus;
              matched = true;
            }

            if (!matched) {
              const t = stats.tasks.find(t => t.taskId === taskId);
              if (t) { t.status = newStatus; matched = true; }
            }

            if (!matched) {
              for (let i = 0; i < stats.tasks.length; i++) {
                if (stats.tasks[i].status !== 'completed' && stats.tasks[i].status !== newStatus) {
                  stats.tasks[i].status = newStatus;
                  matched = true;
                  break;
                }
              }
            }
          }
        }
      }
      break;
    }
    case 'pre_compact':
      if (sessions.has(pid)) sessions.get(pid).status = 'compacting';
      break;
    case 'post_compact':
      if (sessions.has(pid)) sessions.get(pid).status = 'idle';
      break;
    case 'permission_request': {
      const toolName = data?.tool_name || '';
      entry.toolName = toolName;
      entry.toolDetail = getToolDetail(toolName, data?.tool_input);
      const sessName = sessions.has(pid) ? sessions.get(pid).name : pid;
      broadcast('notification', {
        title: '승인 대기',
        message: `${sessName}: ${toolName} 사용 승인을 기다리고 있어요`,
        toolName,
        toolDetail: entry.toolDetail,
      });
      break;
    }
  }

  if (pid && sessions.has(pid) && (type === 'tool_use' || type === 'permission_request' || type === 'post_compact')) {
    saveSession(pid);
  }

  if (sessions.has(pid)) {
    broadcast('session', sessions.get(pid));
  }
  addEvent(entry);
}

// ── Middleware ───────────────────────────────────

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
app.use(express.json({ limit: '10mb' }));
if (session) {
  app.use(session({
    secret: process.env.SESSION_SECRET || 'mashup-dashboard-secret',
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, maxAge: 7 * 24 * 60 * 60 * 1000 },
  }));
}

if (shouldProxyCommunityApi()) {
  app.use(['/api/auth', '/api/community', '/api/chat', '/api/metrics'], proxyCommunityRequest);
}

// ── Routes ───────────────────────────────────────

app.get('/api/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.write('event: connected\ndata: {}\n\n');
  res.write(`event: init\ndata: ${JSON.stringify({ sessions: [...sessions.values()], events })}\n\n`);
  res.write(`event: usage_update\ndata: ${JSON.stringify(getUsageState())}\n\n`);
  clients.add(res);
  req.on('close', () => clients.delete(res));
});

app.get('/api/sessions', (req, res) => {
  res.json([...sessions.values()]);
});

app.get('/api/projects', (req, res) => {
  res.json(aggregateProjects());
});

app.get('/api/bash-commands', (req, res) => {
  const saved = loadAllSavedSessions();
  const now = Date.now();
  const NEW_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
  const NEW_MAX_COUNT = 3;
  const allCmds = [];
  const freq = {};

  for (const s of saved) {
    const project = path.basename(s.cwd || '') || 'unknown';
    for (const c of (s.bashCommands || [])) {
      const pieces = splitPipeline(c.command);
      const isPipeline = pieces.length > 1;
      for (const piece of pieces) {
        const key = normalizeKey(piece);
        if (!key) continue;
        const tokens = tokenizePiece(piece);
        const category = categorizeCmd(piece);

        allCmds.push({
          command: piece,
          normalized: key,
          original: isPipeline ? c.command : null,
          ts: c.ts,
          project,
          category,
          cwd: s.cwd,
          sessionPid: s.pid,
        });

        if (!freq[key]) {
          freq[key] = {
            command: key,
            category,
            count: 0,
            projects: new Set(),
            examples: [],
            firstTs: c.ts,
            lastTs: c.ts,
            coOccur: {},
            flagCounts: {},
            argCounts: {},
          };
        }
        const f = freq[key];
        f.count++;
        f.projects.add(project);
        if (c.ts < f.firstTs) f.firstTs = c.ts;
        if (c.ts > f.lastTs) f.lastTs = c.ts;
        if (isPipeline && f.examples.length < 3 && !f.examples.includes(c.command)) {
          f.examples.push(c.command);
        }
        if (isPipeline) {
          for (const sib of pieces) {
            if (sib === piece) continue;
            const sibKey = normalizeKey(sib);
            if (sibKey) f.coOccur[sibKey] = (f.coOccur[sibKey] || 0) + 1;
          }
        }

        let start = 0;
        while (start < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[start])) start++;
        const headCmd = tokens[start] || '';
        start++;
        if (key.includes(' ')) start++;
        for (let i = start; i < tokens.length; i++) {
          const t = tokens[i];
          if (t.startsWith('-') && t.length > 1) {
            for (const fl of splitShortFlags(t, headCmd)) {
              f.flagCounts[fl] = (f.flagCounts[fl] || 0) + 1;
            }
          } else if (t.length > 0 && t.length <= 40) {
            f.argCounts[t] = (f.argCounts[t] || 0) + 1;
          }
        }
      }
    }
  }

  for (const c of allCmds) {
    const f = freq[c.normalized];
    if (f && (now - f.firstTs) < NEW_WINDOW_MS && f.count <= NEW_MAX_COUNT) {
      c.isNew = true;
    }
  }

  allCmds.sort((a, b) => b.ts - a.ts);

  const topCommands = Object.values(freq).map(f => ({
    command: f.command,
    category: f.category,
    count: f.count,
    projects: [...f.projects],
    examples: f.examples,
    firstTs: f.firstTs,
    lastTs: f.lastTs,
    isNew: (now - f.firstTs) < NEW_WINDOW_MS && f.count <= NEW_MAX_COUNT,
    coOccurrences: Object.entries(f.coOccur)
      .map(([cmd, count]) => ({ cmd, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5),
    topFlags: Object.entries(f.flagCounts)
      .map(([flag, count]) => ({ flag, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10),
    topArgs: Object.entries(f.argCounts)
      .map(([arg, count]) => ({ arg, count }))
      .filter(e => e.count >= 2)
      .sort((a, b) => b.count - a.count)
      .slice(0, 8),
  })).sort((a, b) => b.count - a.count).slice(0, 50);

  const categoryCounts = {};
  for (const c of allCmds) {
    categoryCounts[c.category] = (categoryCounts[c.category] || 0) + 1;
  }

  res.json({
    recent: allCmds.slice(0, 100),
    topCommands,
    categoryCounts,
    total: allCmds.length,
  });
});

app.post('/api/events', (req, res) => {
  try {
    handleEvent(req.body);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.get('/api/events', (req, res) => {
  res.json(events.slice(-100));
});

// 커뮤니티/인증/채팅 모듈이 로드된 경우에만 라우트를 마운트하고,
// DB 미연결 시 503으로 가드한다. (모듈 미로드면 라우트 자체가 없으므로 404)
const dbState = { ready: false };
const requireDb = (_req, res, next) => {
  if (!dbState.ready) {
    return res.status(503).json({
      error: 'community_disabled',
      message: 'MySQL이 연결되지 않아 커뮤니티/인증/채팅 기능이 비활성 상태예요.',
    });
  }
  next();
};

if (communityModulesLoaded) {
  app.use('/api/auth', requireDb, authRouter);
  app.use('/api/community', requireDb, communityRouter);
  app.use('/api/chat', requireDb, chatRouter);
  app.use('/api/metrics', requireDb, metricsRouter);
}
app.use('/api/usage', usageRouter);

app.get('/config.js', (_req, res) => {
  res.type('application/javascript').send(
    `window.MASHUP_DASHBOARD_CONFIG = ${JSON.stringify({
      communityApiUrl: '',
      communityHookApiUrl: COMMUNITY_API_URL,
    })};`
  );
});

app.use(express.static(path.join(__dirname, 'public')));

// ── Start ────────────────────────────────────────

(async () => {
  const dbInit = initDB
    ? initDB().then(() => { dbState.ready = true; })
        .catch(err => console.warn(`[db] MySQL 초기화 실패 — 커뮤니티/인증 기능 비활성화: ${err.message}`))
    : Promise.resolve();

  const usageInit = initUsage().catch(err => {
    console.error('[usage] 초기화 실패:', err.message);
    process.exit(1);
  });

  await Promise.all([dbInit, usageInit]);

  sweepStaleSessions();
  app.listen(PORT, () => {
    console.log(`mash-up-code-agent-dashboard  →  http://localhost:${PORT}`);
    if (!communityModulesLoaded) {
      console.log('  (로컬 모드 · 커뮤니티 의존성 미설치)');
    } else if (!dbState.ready) {
      console.log('  (커뮤니티 비활성 · MySQL 미연결)');
    }
  });
})();
