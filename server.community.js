#!/usr/bin/env node
'use strict';

require('dotenv').config();

const express = require('express');
const session = require('express-session');

const { initDB } = require('./db');
const authRouter = require('./routes/auth');
const communityRouter = require('./routes/community');
const chatRouter = require('./routes/chat');
const metricsRouter = require('./routes/metrics').router;

const app = express();
const PORT = process.env.AGENT_VIZ_PORT || process.env.PORT || 4321;
const SESSION_SECRET = process.env.SESSION_SECRET || 'mashup-dashboard-secret';
const COOKIE_SECURE = process.env.COOKIE_SECURE === 'true';
const CORS_ORIGIN = process.env.CORS_ORIGIN || '';

app.use((req, res, next) => {
  if (CORS_ORIGIN) {
    res.setHeader('Access-Control-Allow-Origin', CORS_ORIGIN);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.use(express.json({ limit: '10mb' }));
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: COOKIE_SECURE,
    sameSite: COOKIE_SECURE ? 'none' : 'lax',
    maxAge: 7 * 24 * 60 * 60 * 1000,
  },
}));

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

app.get('/health', (_req, res) => {
  res.json({ ok: true, dbReady: dbState.ready });
});

app.use('/api/auth', requireDb, authRouter);
app.use('/api/community', requireDb, communityRouter);
app.use('/api/chat', requireDb, chatRouter);
app.use('/api/metrics', requireDb, metricsRouter);

(async () => {
  try {
    await initDB();
    dbState.ready = true;
  } catch (err) {
    console.error(`[db] MySQL 초기화 실패: ${err.message}`);
    process.exit(1);
  }

  app.listen(PORT, () => {
    console.log(`mash-up community backend -> http://localhost:${PORT}`);
  });
})();
