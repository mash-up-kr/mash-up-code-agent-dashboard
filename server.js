#!/usr/bin/env node
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.AGENT_VIZ_PORT || 4321;
const DATA_DIR = path.join(__dirname, 'data');

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// In-memory state
const sessions = new Map(); // pid -> session object
const events = [];          // recent events (max 200)
const clients = new Set();  // SSE clients

// Per-session accumulated stats (for persistence)
const sessionStats = new Map(); // pid -> { toolCounts, modifiedFiles, eventCount, thinkingStartTs }

// ── Inactivity reaper ───────────────────────────
const INACTIVE_TIMEOUT_MS = 3 * 60 * 1000; // 3 minutes

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
}, 5000); // check every 5 seconds

function getSessionStats(pid) {
  if (!sessionStats.has(pid)) {
    // Try to load existing stats from disk
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

function addEvent(entry) {
  events.push(entry);
  if (events.length > 200) events.shift();
  broadcast('event', entry);
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
  // Sanitize pid for filename
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

// ── Project aggregation ──────────────────────────

function aggregateProjects() {
  const saved = loadAllSavedSessions();
  // Group by cwd
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
    proj.sessions.push({
      pid: s.pid,
      name: s.name,
      startedAt: s.startedAt,
      endedAt: s.endedAt,
      status: s.status,
      eventCount: s.eventCount || 0,
      thinkingDuration: s.thinkingDuration || 0,
    });
    proj.totalSessions++;
    proj.totalEvents += (s.eventCount || 0);
    proj.totalThinkingDuration += (s.thinkingDuration || 0);

    // Last activity
    const lastTs = s.endedAt || s.startedAt || 0;
    if (lastTs > proj.lastActivityTs) proj.lastActivityTs = lastTs;

    // Duration
    if (s.startedAt && s.endedAt) {
      proj.totalDuration += (s.endedAt - s.startedAt);
    } else if (s.startedAt && s.status !== 'ended') {
      // Still active — count from start to now
      proj.totalDuration += (Date.now() - s.startedAt);
    }

    // Merge tool counts
    for (const [tool, count] of Object.entries(s.toolCounts || {})) {
      proj.toolCounts[tool] = (proj.toolCounts[tool] || 0) + count;
    }

    // Merge modified files
    for (const [file, count] of Object.entries(s.modifiedFiles || {})) {
      proj.modifiedFiles[file] = (proj.modifiedFiles[file] || 0) + count;
    }

    // Daily activity
    if (s.startedAt) {
      const day = new Date(s.startedAt).toISOString().slice(0, 10);
      proj.dailyActivity[day] = (proj.dailyActivity[day] || 0) + (s.eventCount || 0);
    }

    // Hourly activity
    for (const [hour, count] of Object.entries(s.hourlyActivity || {})) {
      proj.hourlyActivity[hour] = (proj.hourlyActivity[hour] || 0) + count;
    }

    // Aggregate tasks
    for (const t of (s.tasks || [])) {
      proj.tasks.push({ ...t, sessionName: s.name, sessionPid: s.pid });
    }
  }

  // Sort sessions within each project (newest first) and limit modified files
  for (const proj of Object.values(byProject)) {
    proj.sessions.sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
    proj.sessions = proj.sessions.slice(0, 20); // Keep last 20

    // Top 10 modified files
    const fileEntries = Object.entries(proj.modifiedFiles)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10);
    proj.topFiles = fileEntries.map(([file, count]) => ({ file, count }));
    delete proj.modifiedFiles;

    // Deduplicate tasks by subject (keep the one with the latest status/timestamp)
    const taskMap = new Map();
    for (const t of proj.tasks) {
      const key = t.subject.trim().toLowerCase();
      const existing = taskMap.get(key);
      if (!existing) {
        taskMap.set(key, t);
      } else {
        // Prefer the one with a more advanced status, or the newer one
        const statusRank = { completed: 3, in_progress: 2, pending: 1 };
        const eRank = statusRank[existing.status] || 0;
        const tRank = statusRank[t.status] || 0;
        if (tRank > eRank || (tRank === eRank && (t.createdAt || 0) > (existing.createdAt || 0))) {
          taskMap.set(key, t);
        }
      }
    }
    proj.tasks = [...taskMap.values()];

    // Auto-archive: remove completed tasks older than 24h from display
    const archiveCutoff = Date.now() - 24 * 60 * 60 * 1000;
    proj.archivedTaskCount = 0;
    proj.tasks = proj.tasks.filter(t => {
      if (t.status === 'completed' && (t.createdAt || 0) < archiveCutoff) {
        proj.archivedTaskCount++;
        return false;
      }
      return true;
    });

    // Sort: in_progress first, then pending, then completed; within group by newest
    const statusOrder = { in_progress: 0, pending: 1, completed: 2 };
    proj.tasks.sort((a, b) => {
      const oa = statusOrder[a.status] ?? 1, ob = statusOrder[b.status] ?? 1;
      if (oa !== ob) return oa - ob;
      return (b.createdAt || 0) - (a.createdAt || 0);
    });
    proj.tasks = proj.tasks.slice(0, 30);
  }

  // Sort projects by most recent activity
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

  // Auto-create session if first event arrives before session_start
  if (pid && !sessions.has(pid) && type !== 'session_end') {
    // Preserve startedAt from existing saved session
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

  // Update lastActivityAt on every event
  if (pid && sessions.has(pid)) {
    sessions.get(pid).lastActivityAt = ts;
  }

  // Track stats
  if (pid) {
    const stats = getSessionStats(pid);
    stats.eventCount++;
    const hour = String(new Date(ts).getHours());
    stats.hourlyActivity[hour] = (stats.hourlyActivity[hour] || 0) + 1;
  }

  switch (type) {
    case 'session_start': {
      // Preserve startedAt from existing saved session
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
        // Broadcast notification
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
      // Notify that Claude finished responding
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
      // Pre-tool: only set entry metadata for the event broadcast, no stat tracking
      const preToolName = data?.tool_name || '';
      entry.toolName = preToolName;
      entry.toolDetail = getToolDetail(preToolName, data?.tool_input);
      break;
    }
    case 'tool_use': {
      const toolName = data?.tool_name || '';
      entry.toolName = toolName;
      entry.toolDetail = getToolDetail(toolName, data?.tool_input);

      if (pid) {
        const stats = getSessionStats(pid);
        stats.toolCounts[toolName] = (stats.toolCounts[toolName] || 0) + 1;

        // Track modified files
        if (['Write', 'Edit'].includes(toolName) && data?.tool_input?.file_path) {
          const filePath = data.tool_input.file_path;
          stats.modifiedFiles[filePath] = (stats.modifiedFiles[filePath] || 0) + 1;
        }

        // Track bash commands
        if (toolName === 'Bash' && data?.tool_input?.command) {
          const cmd = data.tool_input.command.trim();
          if (cmd && stats.bashCommands.length < 500) {
            stats.bashCommands.push({ command: cmd, ts });
          }
        }

        // Track tasks
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
          // Cap: keep max 50 tasks per session, prune oldest completed first
          if (stats.tasks.length > 50) {
            const completedIdx = stats.tasks.findIndex(t => t.status === 'completed');
            if (completedIdx !== -1) stats.tasks.splice(completedIdx, 1);
            else stats.tasks.shift(); // no completed left, drop oldest
          }
        }
        if (toolName === 'TaskUpdate' && data?.tool_input) {
          if (!stats.tasks) stats.tasks = [];
          const taskId = data.tool_input.taskId;
          const newStatus = data.tool_input.status;
          if (newStatus && stats.tasks.length > 0) {
            // Global taskId doesn't match session-local array index.
            // Strategy: try session-local 1-based index, stored taskId, then
            // fallback to matching the most recent task with a different status.
            const idx = parseInt(taskId) - 1;
            let matched = false;

            // 1) Exact session-local index (only if within range)
            if (idx >= 0 && idx < stats.tasks.length) {
              stats.tasks[idx].status = newStatus;
              matched = true;
            }

            // 2) Search by stored taskId
            if (!matched) {
              const t = stats.tasks.find(t => t.taskId === taskId);
              if (t) { t.status = newStatus; matched = true; }
            }

            // 3) Fallback: update the oldest non-completed task (FIFO order)
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
      // Broadcast notification so the dashboard can alert the user
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

  // Periodically save session stats
  if (pid && sessions.has(pid) && (type === 'tool_use' || type === 'permission_request' || type === 'post_compact')) {
    saveSession(pid);
  }

  if (sessions.has(pid)) {
    broadcast('session', sessions.get(pid));
  }
  addEvent(entry);
}

// ── HTTP Server ──────────────────────────────────

const MIME = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const { pathname } = url;

  res.setHeader('Access-Control-Allow-Origin', '*');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  // SSE stream
  if (pathname === '/api/stream') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write('event: connected\ndata: {}\n\n');
    res.write(`event: init\ndata: ${JSON.stringify({ sessions: [...sessions.values()], events })}\n\n`);
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }

  // Sessions list
  if (pathname === '/api/sessions' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify([...sessions.values()]));
  }

  // Project aggregation
  if (pathname === '/api/projects' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(aggregateProjects()));
  }

  // Bash commands (all sessions, all projects)
  if (pathname === '/api/bash-commands' && req.method === 'GET') {
    const saved = loadAllSavedSessions();
    const allCmds = [];
    for (const s of saved) {
      for (const c of (s.bashCommands || [])) {
        allCmds.push({
          command: c.command,
          ts: c.ts,
          project: path.basename(s.cwd || '') || 'unknown',
          cwd: s.cwd,
          sessionPid: s.pid,
        });
      }
    }
    // Sort newest first
    allCmds.sort((a, b) => b.ts - a.ts);

    // Also build frequency map
    const freq = {};
    for (const c of allCmds) {
      const normalized = c.command.split('\n')[0].trim().slice(0, 200);
      if (!freq[normalized]) freq[normalized] = { command: normalized, count: 0, projects: new Set(), lastTs: 0 };
      freq[normalized].count++;
      freq[normalized].projects.add(c.project);
      if (c.ts > freq[normalized].lastTs) freq[normalized].lastTs = c.ts;
    }
    const topCommands = Object.values(freq)
      .map(f => ({ ...f, projects: [...f.projects] }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 50);

    // Categorize
    function categorize(cmd) {
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

    const categoryCounts = {};
    for (const c of allCmds) {
      const cat = categorize(c.command);
      categoryCounts[cat] = (categoryCounts[cat] || 0) + 1;
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      recent: allCmds.slice(0, 100),
      topCommands,
      categoryCounts,
      total: allCmds.length,
    }));
  }

  // Event ingestion (from hook-handler.sh)
  if (pathname === '/api/events' && req.method === 'POST') {
    let raw = '';
    req.on('data', c => (raw += c));
    req.on('end', () => {
      try {
        handleEvent(JSON.parse(raw));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"ok":true}');
      } catch (e) {
        res.writeHead(400);
        res.end(`{"error":"${e.message}"}`);
      }
    });
    return;
  }

  // Recent events (for debug)
  if (pathname === '/api/events' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(events.slice(-100)));
  }

  // Static files
  const filePath = path.join(__dirname, 'public', pathname === '/' ? 'index.html' : pathname);
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'text/plain' });
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log(`mash-up-code-agent-dashboard  →  http://localhost:${PORT}`);
});
