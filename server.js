#!/usr/bin/env node
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.AGENT_VIZ_PORT || 4321;

// In-memory state
const sessions = new Map(); // pid -> { pid, cwd, name, sid, status, startedAt }
const events = [];          // recent events (max 200)
const clients = new Set();  // SSE clients

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
    });
  }

  switch (type) {
    case 'session_start':
      sessions.set(pid, {
        pid, cwd, sid,
        name: name || path.basename(cwd || '') || 'unknown',
        status: 'idle',
        startedAt: ts,
      });
      break;
    case 'session_end':
      if (sessions.has(pid)) {
        sessions.get(pid).status = 'ended';
        setTimeout(() => sessions.delete(pid), 3000);
      }
      break;
    case 'thinking_start':
      if (sessions.has(pid)) sessions.get(pid).status = 'thinking';
      break;
    case 'thinking_end':
      if (sessions.has(pid)) sessions.get(pid).status = 'idle';
      break;
    case 'agent_start':
      if (sessions.has(pid)) sessions.get(pid).status = 'running';
      entry.agentName = data?.tool_input?.agent_name || '';
      break;
    case 'agent_done':
      if (sessions.has(pid)) sessions.get(pid).status = 'idle';
      break;
    case 'tool_use':
      entry.toolName = data?.tool_name || '';
      entry.toolDetail = getToolDetail(data?.tool_name, data?.tool_input);
      break;
  }

  if (sessions.has(pid)) {
    broadcast('session', sessions.get(pid));
  }
  addEvent(entry);
}

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
  console.log(`claude-agent-viz-simple  →  http://localhost:${PORT}`);
});