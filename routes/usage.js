'use strict';

const fs      = require('fs');
const path    = require('path');
const os      = require('os');
const { Router } = require('express');
const Database   = require('better-sqlite3');
const chokidar   = require('chokidar');

const CLAUDE_PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');
const DATA_DIR = path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// ── SQLite ──────────────────────────────────────
const db = new Database(path.join(DATA_DIR, 'usage.db'));
db.exec(`
  CREATE TABLE IF NOT EXISTS usage_records (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    project_path TEXT,
    model TEXT,
    input_tokens INTEGER,
    output_tokens INTEGER,
    cache_creation_tokens INTEGER,
    cache_read_tokens INTEGER,
    recorded_at TEXT
  );
  CREATE TABLE IF NOT EXISTS file_offsets (
    file_path TEXT PRIMARY KEY,
    last_offset INTEGER,
    last_synced_at TEXT
  );
  CREATE TABLE IF NOT EXISTS usage_sessions (
    session_id TEXT PRIMARY KEY,
    session_name TEXT
  );
`);

const stmtInsertRecord = db.prepare(`
  INSERT INTO usage_records
    (session_id, project_path, model, input_tokens, output_tokens,
     cache_creation_tokens, cache_read_tokens, recorded_at)
  VALUES
    (@session_id, @project_path, @model, @input_tokens, @output_tokens,
     @cache_creation_tokens, @cache_read_tokens, @recorded_at)
`);
const stmtFlushAndUpdateOffset = db.transaction((rows, filePath, newOffset, now) => {
  for (const r of rows) stmtInsertRecord.run(r);
  stmtUpsertOffset.run(filePath, newOffset, now);
});
const stmtUpsertOffset = db.prepare(`
  INSERT INTO file_offsets (file_path, last_offset, last_synced_at)
  VALUES (?, ?, ?)
  ON CONFLICT(file_path) DO UPDATE SET
    last_offset = excluded.last_offset,
    last_synced_at = excluded.last_synced_at
`);
const stmtGetOffset = db.prepare('SELECT last_offset FROM file_offsets WHERE file_path = ?');
const stmtUpsertSession = db.prepare(`
  INSERT INTO usage_sessions (session_id, session_name) VALUES (?, ?)
  ON CONFLICT(session_id) DO NOTHING
`);
const stmtGetSession = db.prepare('SELECT session_name FROM usage_sessions WHERE session_id = ?');

// ── Memory state ────────────────────────────────
const usageState = {
  updatedAt: null,
  weeklySessionCount: 0,
  rateLimits: {
    fiveHour: null,
    sevenDay: null,
    updatedAt: null,
  },
  daily: {},    // { 'YYYY-MM-DD': { 'Sonnet 4.6': N, ... } }
  projects: {}, // { projectPath: { totalTokens, sessionCount, cacheEfficiency, lastActivity, sessions } }
};

// SSE clients
const usageClients = new Set();

// ── Helpers ─────────────────────────────────────
function normalizeModel(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const m = raw.match(/^claude-([a-z]+)-([\d]+)-([\d]+)/);
  if (!m) return null; // <synthetic> 등 내부 모델 제외
  return m[1].charAt(0).toUpperCase() + m[1].slice(1) + ' ' + m[2] + '.' + m[3];
}

function toLocalDateKey(input) {
  const d = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(d.getTime())) return '';
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function safeResolve(p) {
  const resolved = path.resolve(p);
  if (!resolved.startsWith(os.homedir())) throw new Error('path traversal');
  return resolved;
}

function broadcastUsage() {
  const payload = `event: usage_update\ndata: ${JSON.stringify(usageState)}\n\n`;
  for (const res of usageClients) {
    try { res.write(payload); } catch (_) { usageClients.delete(res); }
  }
}

function touchUsageState(ts = new Date().toISOString()) {
  usageState.updatedAt = ts;
  usageState.weeklySessionCount = calculateWeeklySessionCount(usageState.projects);
}

function calculateWeeklySessionCount(projects) {
  const threshold = Date.now() - (7 * 24 * 60 * 60 * 1000);
  let total = 0;
  for (const proj of Object.values(projects || {})) {
    for (const sess of Object.values(proj.sessions || {})) {
      const ts = sess.lastActivity ? new Date(sess.lastActivity).getTime() : NaN;
      if (Number.isFinite(ts) && ts >= threshold) total++;
    }
  }
  return total;
}

function normalizeRateLimitWindow(window) {
  if (!window) return null;
  const usedPercentage = Number(
    window.used_percentage ??
    window.usedPercentage
  );
  const resetsAtRaw = window.resets_at ?? window.resetsAt ?? null;
  let resetsAt = null;
  if (typeof resetsAtRaw === 'number' && Number.isFinite(resetsAtRaw)) {
    resetsAt = new Date(resetsAtRaw * 1000).toISOString();
  } else if (typeof resetsAtRaw === 'string') {
    const numeric = Number(resetsAtRaw);
    resetsAt = Number.isFinite(numeric)
      ? new Date(numeric * 1000).toISOString()
      : resetsAtRaw;
  }
  return {
    usedPercentage: Number.isFinite(usedPercentage) ? usedPercentage : null,
    resetsAt,
  };
}

function updateRateLimits(rateLimits) {
  usageState.rateLimits = {
    fiveHour: normalizeRateLimitWindow(rateLimits?.five_hour),
    sevenDay: normalizeRateLimitWindow(rateLimits?.seven_day),
    updatedAt: new Date().toISOString(),
  };
  broadcastUsage();
}

// ── State update ─────────────────────────────────
function applyRecord(r) {
  if (!r.model || !r.model.match(/^[A-Z]/)) return; // <synthetic> 등 제외
  const day = toLocalDateKey(r.recorded_at);
  if (!day) return;
  const sessionId = r.sessionId || r.session_id || null;

  const totalTokens = (r.input_tokens || 0) + (r.output_tokens || 0);
  const cacheRead   = r.cache_read_tokens || 0;
  const cacheCreate = r.cache_creation_tokens || 0;
  const inputTok    = r.input_tokens || 0;

  // daily
  if (!usageState.daily[day]) usageState.daily[day] = {};
  usageState.daily[day][r.model] = (usageState.daily[day][r.model] || 0) + totalTokens;

  // project
  const pp = r.project_path;
  if (!usageState.projects[pp]) {
    usageState.projects[pp] = {
      totalTokens: 0, sessionCount: 0,
      cacheEfficiency: null, lastActivity: null,
      sessions: {},
      _cacheNum: 0, _cacheDen: 0,
    };
  }
  const proj = usageState.projects[pp];
  proj.totalTokens += totalTokens;
  if (!proj.lastActivity || r.recorded_at > proj.lastActivity) proj.lastActivity = r.recorded_at;

  if (!proj.sessions[sessionId]) {
    const sessionRow = stmtGetSession.get(sessionId);
    proj.sessions[sessionId] = {
      sessionId,
      sessionName:     r.sessionName || (sessionRow ? sessionRow.session_name : sessionId.slice(0, 8)),
      date:            day,
      tokens:          0,
      model:           r.model,
      lastActivity:    r.recorded_at,
      cacheEfficiency: null,
      _cacheNum:       0,
      _cacheDen:       0,
    };
    proj.sessionCount++;
  }
  const sess = proj.sessions[sessionId];
  sess.sessionId  = sess.sessionId || sessionId;
  sess.tokens     += totalTokens;
  sess.model       = r.model;
  if (r.recorded_at > sess.lastActivity) sess.lastActivity = r.recorded_at;
  sess._cacheNum  += cacheRead;
  sess._cacheDen  += inputTok + cacheCreate + cacheRead;
  sess.cacheEfficiency = sess._cacheDen > 0 ? sess._cacheNum / sess._cacheDen : null;

  proj._cacheNum  += cacheRead;
  proj._cacheDen  += inputTok + cacheCreate + cacheRead;
  proj.cacheEfficiency = proj._cacheDen > 0 ? proj._cacheNum / proj._cacheDen : null;
  touchUsageState();
}

// ── JSONL incremental parser ─────────────────────
const fileParseQueues = new Map();
let periodicRescanInFlight = false;

async function parseFile(filePath, sessionId, fallbackProjectPath) {
  let safe;
  try { safe = safeResolve(filePath); }
  catch (e) { console.error('[usage] security:', e.message); return; }

  let stat;
  try { stat = fs.statSync(safe); }
  catch (e) { return; }

  const offsetRow = stmtGetOffset.get(safe);
  let offset = offsetRow ? offsetRow.last_offset : 0;
  if (offset > stat.size) offset = 0; // file replaced
  if (offset >= stat.size) return;

  const isFirstRead = (offset === 0);
  const newRecords  = [];
  let sessionName   = null;
  let processedOffset = offset;

  await new Promise((resolve) => {
    const stream = fs.createReadStream(safe, { start: offset });
    let remainder = Buffer.alloc(0);
    let totalBytesRead = 0;

    stream.on('data', (chunk) => {
      totalBytesRead += chunk.length;
      const buf = Buffer.concat([remainder, chunk]);
      let start = 0;
      let nlIdx;

      while ((nlIdx = buf.indexOf(0x0A, start)) !== -1) {
        const line = buf.subarray(start, nlIdx).toString('utf8');

        if (line.trim()) {
          let rec;
          try { rec = JSON.parse(line); } catch (_) {
            start = nlIdx + 1;
            continue;
          }

          if (isFirstRead && !sessionName && rec.type === 'user') {
            const contents = rec.message?.content;
            if (Array.isArray(contents)) {
              const text = contents.find(c => c.type === 'text' && c.text?.trim());
              if (text) sessionName = text.text.trim().slice(0, 20);
            } else if (typeof contents === 'string') {
              sessionName = contents.trim().slice(0, 20);
            }
          }

          if (rec.type === 'assistant') {
            const usage = rec.message?.usage;
            const rawModel = rec.message?.model;
            if (usage && rawModel) {
              const r = {
                session_id:             sessionId,
                sessionId:              rec.sessionId || rec.session_id || sessionId,
                project_path:           rec.cwd || fallbackProjectPath || '',
                model:                  normalizeModel(rawModel),
                input_tokens:           usage.input_tokens || 0,
                output_tokens:          usage.output_tokens || 0,
                cache_creation_tokens:  usage.cache_creation_input_tokens || 0,
                cache_read_tokens:      usage.cache_read_input_tokens || 0,
                recorded_at:            rec.timestamp || new Date().toISOString(),
              };
              if (r.model) {
                applyRecord(r);
                newRecords.push(r);
              }
            }
          }
        }

        start = nlIdx + 1;
      }

      remainder = buf.subarray(start);
      processedOffset = offset + totalBytesRead - remainder.length;
    });

    stream.on('end', resolve);
    stream.on('error', (e) => {
      if (e.code === 'EACCES' || e.code === 'EPERM') {
        console.error('[usage] permission denied:', safe);
      } else {
        console.error('[usage] read error:', safe, e.message);
      }
      resolve();
    });
  });

  // 세션 이름 저장
  if (isFirstRead && sessionName) {
    stmtUpsertSession.run(sessionId, sessionName);
    // 메모리 반영
    for (const proj of Object.values(usageState.projects)) {
      if (proj.sessions[sessionId]) {
        proj.sessions[sessionId].sessionName = sessionName;
      }
    }
  }

  if (processedOffset > offset) {
    stmtFlushAndUpdateOffset(newRecords, safe, processedOffset, new Date().toISOString());
    if (newRecords.length > 0) touchUsageState();
  }
}

function enqueueFileParse(filePath, sessionId, fallbackProjectPath) {
  const queueKey = path.resolve(filePath);
  const previous = fileParseQueues.get(queueKey) || Promise.resolve();
  const current = previous
    .catch(() => {})
    .then(async () => {
      await parseFile(filePath, sessionId, fallbackProjectPath);
      broadcastUsage();
    });

  fileParseQueues.set(queueKey, current);
  current.finally(() => {
    if (fileParseQueues.get(queueKey) === current) {
      fileParseQueues.delete(queueKey);
    }
  });
  return current;
}

// ── Restore from SQLite ──────────────────────────
function restoreFromSQLite() {
  const rows = db.prepare('SELECT * FROM usage_records ORDER BY recorded_at ASC').all();
  for (const r of rows) applyRecord(r);
  console.log(`[usage] Restored ${rows.length} records from SQLite`);
}

async function scanAllJsonlFiles() {
  let projectDirs;
  try { projectDirs = fs.readdirSync(CLAUDE_PROJECTS_DIR); }
  catch (e) { console.error('[usage] Cannot read projects dir:', e.message); return; }

  for (const pDir of projectDirs) {
    const pPath = path.join(CLAUDE_PROJECTS_DIR, pDir);
    let entries;
    try { entries = fs.readdirSync(pPath); } catch (_) { continue; }

    for (const entry of entries) {
      if (entry.endsWith('.jsonl')) {
        const sessionId = entry.replace('.jsonl', '');
        await enqueueFileParse(path.join(pPath, entry), sessionId, '');
      }
      // subagents
      const subDir = path.join(pPath, entry, 'subagents');
      try {
        const subs = fs.readdirSync(subDir);
        for (const sub of subs) {
          if (sub.endsWith('.jsonl')) {
            await enqueueFileParse(path.join(subDir, sub), entry, '');
          }
        }
      } catch (_) {}
    }
  }
}

// ── Initial scan ─────────────────────────────────
async function initialScan() {
  console.log('[usage] Initial JSONL scan...');
  await scanAllJsonlFiles();
  console.log(`[usage] Scan done. Projects: ${Object.keys(usageState.projects).length}`);
}

function startPeriodicRescan() {
  setInterval(async () => {
    if (periodicRescanInFlight) return;
    periodicRescanInFlight = true;
    try {
      const prevUpdatedAt = usageState.updatedAt;
      await scanAllJsonlFiles();
      if (usageState.updatedAt && usageState.updatedAt !== prevUpdatedAt) {
        broadcastUsage();
      }
    } catch (e) {
      console.error('[usage] Periodic rescan failed:', e.message);
    } finally {
      periodicRescanInFlight = false;
    }
  }, 30 * 1000);
}

// ── Chokidar watcher ─────────────────────────────
function startWatcher() {
  const watcher = chokidar.watch(path.join(CLAUDE_PROJECTS_DIR, '**', '*.jsonl'), {
    persistent: true,
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 100 },
  });

  // 같은 파일의 연속 이벤트를 2초로 debounce — SQLite 쓰기 빈도 감소
  const debounceTimers = new Map();

  const handle = (filePath) => {
    if (debounceTimers.has(filePath)) clearTimeout(debounceTimers.get(filePath));
    debounceTimers.set(filePath, setTimeout(async () => {
      debounceTimers.delete(filePath);
      const rel   = path.relative(CLAUDE_PROJECTS_DIR, filePath);
      const parts = rel.split(path.sep);
      let sessionId;
      if (parts.length === 2 && parts[1].endsWith('.jsonl')) {
        sessionId = parts[1].replace('.jsonl', '');
      } else if (parts.length >= 4 && parts[2] === 'subagents') {
        sessionId = parts[1];
      } else return;

      await enqueueFileParse(filePath, sessionId, '');
    }, 2000));
  };

  watcher.on('change', handle);
  watcher.on('add',    handle);
  console.log('[usage] Watcher started');
}

// ── Router ───────────────────────────────────────
const router = Router();

router.get('/snapshot', (_req, res) => res.json(usageState));

router.get('/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type':  'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection':    'keep-alive',
  });
  res.write('event: connected\ndata: {}\n\n');
  res.write(`event: usage_update\ndata: ${JSON.stringify(usageState)}\n\n`);
  usageClients.add(res);
  req.on('close', () => usageClients.delete(res));
});

// ── Init ─────────────────────────────────────────
async function init() {
  restoreFromSQLite();
  await initialScan();
  startWatcher();
  startPeriodicRescan();
}

module.exports = { router, init, updateRateLimits };
