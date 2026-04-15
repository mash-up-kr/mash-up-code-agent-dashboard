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

function getSessionStats(pid) {
  if (!sessionStats.has(pid)) {
    sessionStats.set(pid, {
      toolCounts: {},
      modifiedFiles: {},
      eventCount: 0,
      thinkingStartTs: null,
      thinkingDuration: 0,
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
    });
    proj.totalSessions++;
    proj.totalEvents += (s.eventCount || 0);
    proj.totalThinkingDuration += (s.thinkingDuration || 0);

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
    sessions.set(pid, {
      pid, cwd, sid,
      name: name || path.basename(cwd || '') || 'unknown',
      status: 'idle',
      startedAt: ts,
      endedAt: null,
    });
  }

  // Track stats
  if (pid) {
    const stats = getSessionStats(pid);
    stats.eventCount++;
  }

  switch (type) {
    case 'session_start':
      sessions.set(pid, {
        pid, cwd, sid,
        name: name || path.basename(cwd || '') || 'unknown',
        status: 'idle',
        startedAt: ts,
        endedAt: null,
      });
      saveSession(pid);
      break;
    case 'session_end':
      if (sessions.has(pid)) {
        const sess = sessions.get(pid);
        sess.status = 'ended';
        sess.endedAt = ts;
        saveSession(pid);
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
    case 'agent_start':
      if (sessions.has(pid)) sessions.get(pid).status = 'running';
      entry.agentName = data?.tool_input?.agent_name || '';
      break;
    case 'agent_done':
      if (sessions.has(pid)) sessions.get(pid).status = 'idle';
      break;
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
      }
      break;
    }
  }

  // Periodically save session stats
  if (pid && sessions.has(pid) && type === 'tool_use') {
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
