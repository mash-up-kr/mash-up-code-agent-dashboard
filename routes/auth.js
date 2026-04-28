'use strict';

const { Router } = require('express');
const bcrypt     = require('bcrypt');
const crypto     = require('crypto');
const { pool }   = require('../db');

const router = Router();
const SALT_ROUNDS = 10;

// GET /api/auth/me — 현재 세션 확인
router.get('/me', (req, res) => {
  if (!req.session.memberId) return res.status(401).json({ error: '로그인이 필요합니다.' });
  res.json({ memberId: req.session.memberId, name: req.session.name, username: req.session.username });
});

// POST /api/auth/register — 회원가입
router.post('/register', async (req, res) => {
  const { username, password, name } = req.body;
  if (!username?.trim() || !password || !name?.trim()) {
    return res.status(400).json({ error: '아이디, 비밀번호, 이름을 모두 입력해주세요.' });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: '비밀번호는 6자 이상이어야 합니다.' });
  }

  try {
    const [existing] = await pool.execute('SELECT id FROM members WHERE username = ?', [username.trim()]);
    if (existing.length > 0) return res.status(409).json({ error: '이미 사용 중인 아이디입니다.' });

    const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
    const hookToken = crypto.randomBytes(32).toString('hex');
    const [result] = await pool.execute(
      'INSERT INTO members (username, password_hash, name, hook_token) VALUES (?, ?, ?, ?)',
      [username.trim(), passwordHash, name.trim(), hookToken]
    );

    req.session.memberId = result.insertId;
    req.session.username = username.trim();
    req.session.name     = name.trim();
    res.status(201).json({
      memberId: result.insertId,
      name: name.trim(),
      username: username.trim(),
      hookToken,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: '회원가입 중 오류가 발생했습니다.' });
  }
});

// POST /api/auth/login — 로그인
router.post('/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username?.trim() || !password) {
    return res.status(400).json({ error: '아이디와 비밀번호를 입력해주세요.' });
  }

  try {
    const [rows] = await pool.execute('SELECT id, password_hash, name FROM members WHERE username = ?', [username.trim()]);
    if (rows.length === 0) return res.status(401).json({ error: '아이디 또는 비밀번호가 올바르지 않습니다.' });

    const member = rows[0];
    const valid  = await bcrypt.compare(password, member.password_hash);
    if (!valid) return res.status(401).json({ error: '아이디 또는 비밀번호가 올바르지 않습니다.' });

    req.session.memberId = member.id;
    req.session.username = username.trim();
    req.session.name     = member.name;
    res.json({ memberId: member.id, name: member.name, username: username.trim() });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: '로그인 중 오류가 발생했습니다.' });
  }
});

// POST /api/auth/logout — 로그아웃
router.post('/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

module.exports = router;
