'use strict';

/*
 * Chat backend module.
 *
 * Exposes handle(req, res, url) for server.js to delegate /api/chat/* paths.
 * Implements SSE stream, message send, and history fetch against MySQL.
 * Falls back to an in-memory store if MySQL is unreachable so the frontend
 * still works during local development without a DB.
 */

const mysql = require('mysql2/promise');

const MAX_CLIENTS = 12;
const HISTORY_LIMIT = 50;
const CONTENT_MAX_LENGTH = 2000;
const USER_NAME_MAX_LENGTH = 64;

const DB_CONFIG = {
  host: process.env.CHAT_DB_HOST || 'localhost',
  port: Number(process.env.CHAT_DB_PORT) || 3306,
  user: process.env.CHAT_DB_USER || 'root',
  password: process.env.CHAT_DB_PASS || '',
  database: process.env.CHAT_DB_NAME || 'chat_db',
  waitForConnections: true,
  connectionLimit: 10,
};

const clients = new Set();
let pool = null;
let dbReady = false;
const memoryMessages = [];
let memoryNextId = 1;

async function initDb() {
  try {
    pool = mysql.createPool(DB_CONFIG);
    await pool.query('SELECT 1');
    await pool.query(`
      CREATE TABLE IF NOT EXISTS messages (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        user_name VARCHAR(${USER_NAME_MAX_LENGTH}) NOT NULL,
        content TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_created (created_at)
      ) CHARSET=utf8mb4
    `);
    dbReady = true;
    console.log('[chat] MySQL connected');
  } catch (err) {
    dbReady = false;
    console.warn('[chat] MySQL unavailable, using in-memory store:', err.code || err.message);
  }
}

initDb();

async function fetchRecent(limit = HISTORY_LIMIT) {
  if (dbReady) {
    const [rows] = await pool.query(
      'SELECT id, user_name AS userName, content, created_at AS createdAt FROM messages ORDER BY id DESC LIMIT ?',
      [limit]
    );
    return rows.reverse();
  }
  return memoryMessages.slice(-limit);
}

async function insertMessage(userName, content) {
  if (dbReady) {
    const [result] = await pool.query(
      'INSERT INTO messages (user_name, content) VALUES (?, ?)',
      [userName, content]
    );
    return {
      id: result.insertId,
      userName,
      content,
      createdAt: new Date(),
    };
  }
  const msg = {
    id: memoryNextId++,
    userName,
    content,
    createdAt: new Date(),
  };
  memoryMessages.push(msg);
  if (memoryMessages.length > 500) memoryMessages.shift();
  return msg;
}

function broadcast(eventName, data) {
  const payload = `event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) {
    try { res.write(payload); } catch (_) { clients.delete(res); }
  }
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function readJsonBody(req) {
  // If upstream middleware (e.g. express.json()) already parsed the body,
  // just use it. Otherwise fall back to streaming the raw request.
  if (req.body && typeof req.body === 'object') {
    return req.body;
  }
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 1_000_000) {
        reject(new Error('payload too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); }
      catch (err) { reject(err); }
    });
    req.on('error', reject);
  });
}

async function handleStream(req, res) {
  if (clients.size >= MAX_CLIENTS) {
    res.writeHead(503, { 'Content-Type': 'text/plain' });
    return res.end(`chat is full (max ${MAX_CLIENTS} connections)`);
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  res.write('event: connected\ndata: {}\n\n');

  try {
    const recent = await fetchRecent();
    res.write(`event: init\ndata: ${JSON.stringify({ messages: recent, dbReady })}\n\n`);
  } catch (err) {
    console.error('[chat] failed to load history:', err);
    res.write(`event: init\ndata: ${JSON.stringify({ messages: [], dbReady })}\n\n`);
  }

  clients.add(res);
  req.on('close', () => clients.delete(res));

  const keepAlive = setInterval(() => {
    try { res.write(': ping\n\n'); }
    catch (_) { clearInterval(keepAlive); }
  }, 30_000);
  req.on('close', () => clearInterval(keepAlive));
}

async function handleSend(req, res) {
  let body;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    return sendJson(res, 400, { error: 'invalid json' });
  }

  const userName = String(body.userName || '').trim();
  const content = String(body.content || '').trim();

  if (!userName) return sendJson(res, 400, { error: 'userName required' });
  if (!content) return sendJson(res, 400, { error: 'content required' });
  if (userName.length > USER_NAME_MAX_LENGTH) return sendJson(res, 400, { error: 'userName too long' });
  if (content.length > CONTENT_MAX_LENGTH) return sendJson(res, 400, { error: 'content too long' });

  try {
    const msg = await insertMessage(userName, content);
    broadcast('chat', msg);
    sendJson(res, 200, { ok: true, message: msg });
  } catch (err) {
    console.error('[chat] insert failed:', err);
    sendJson(res, 500, { error: 'failed to save message' });
  }
}

async function handleHistory(req, res, url) {
  const limit = Math.min(Number(url.searchParams.get('limit')) || HISTORY_LIMIT, 200);
  try {
    const rows = await fetchRecent(limit);
    sendJson(res, 200, { messages: rows, dbReady });
  } catch (err) {
    console.error('[chat] history fetch failed:', err);
    sendJson(res, 500, { error: 'failed to fetch history' });
  }
}

function handleStatus(req, res) {
  sendJson(res, 200, {
    dbReady,
    connectedClients: clients.size,
    maxClients: MAX_CLIENTS,
  });
}

async function handle(req, res, url) {
  const { pathname } = url;

  if (pathname === '/api/chat/stream' && req.method === 'GET') {
    return handleStream(req, res);
  }
  if (pathname === '/api/chat/send' && req.method === 'POST') {
    return handleSend(req, res);
  }
  if (pathname === '/api/chat/history' && req.method === 'GET') {
    return handleHistory(req, res, url);
  }
  if (pathname === '/api/chat/status' && req.method === 'GET') {
    return handleStatus(req, res);
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'chat endpoint not found' }));
}

module.exports = { handle };
