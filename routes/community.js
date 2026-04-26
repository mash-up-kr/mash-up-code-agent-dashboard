'use strict';

const { Router } = require('express');
const { pool }   = require('../db');

const router = Router();

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function generateCode() {
  return Array.from({ length: 8 }, () =>
    CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]
  ).join('');
}

async function uniqueCode() {
  for (let i = 0; i < 5; i++) {
    const code = generateCode();
    const [rows] = await pool.execute('SELECT id FROM `groups` WHERE code = ?', [code]);
    if (rows.length === 0) return code;
  }
  throw new Error('코드 생성 실패');
}

// GET /api/community/groups?memberId=1 — 내 그룹 목록 조회
router.get('/groups', async (req, res) => {
  const memberId = Number(req.query.memberId);
  if (!memberId) return res.status(400).json({ error: 'memberId가 필요합니다.' });

  const [rows] = await pool.execute(`
    SELECT
      g.id,
      g.name,
      g.code,
      g.max_members,
      COUNT(all_m.id) AS member_count,
      my_m.is_creator
    FROM \`groups\` g
    JOIN group_members my_m  ON my_m.group_id  = g.id AND my_m.member_id = ?
    LEFT JOIN group_members all_m ON all_m.group_id = g.id
    GROUP BY g.id, g.name, g.code, g.max_members, my_m.is_creator
    ORDER BY g.created_at DESC
  `, [memberId]);

  res.json(rows.map(r => ({
    id:          r.id,
    name:        r.name,
    code:        r.code,
    maxMembers:  r.max_members,
    memberCount: Number(r.member_count),
    isCreator:   Boolean(r.is_creator),
  })));
});

// POST /api/community/groups — 그룹 생성
router.post('/groups', async (req, res) => {
  const { name, nickname, maxMembers = 20, memberId: existingMemberId } = req.body;
  if (!name?.trim() || !nickname?.trim()) {
    return res.status(400).json({ error: '그룹 이름과 닉네임을 입력해주세요.' });
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    // 기존 memberId가 있으면 재사용, 없으면 새 멤버 생성
    let memberId = Number(existingMemberId) || 0;
    if (memberId) {
      const [rows] = await conn.execute('SELECT id FROM members WHERE id = ?', [memberId]);
      if (rows.length === 0) memberId = 0; // 유효하지 않으면 새로 생성
    }
    if (!memberId) {
      const [memberResult] = await conn.execute(
        'INSERT INTO members (nickname) VALUES (?)',
        [nickname.trim()]
      );
      memberId = memberResult.insertId;
    }

    // 그룹 생성
    const code = await uniqueCode();
    const [groupResult] = await conn.execute(
      'INSERT INTO `groups` (name, code, max_members) VALUES (?, ?, ?)',
      [name.trim(), code, Number(maxMembers) || 20]
    );
    const groupId = groupResult.insertId;

    // 생성자 자동 참여
    await conn.execute(
      'INSERT INTO group_members (group_id, member_id, nickname, is_creator) VALUES (?, ?, ?, 1)',
      [groupId, memberId, nickname.trim()]
    );

    await conn.commit();
    res.status(201).json({ groupId, name: name.trim(), code, memberId });
  } catch (e) {
    await conn.rollback();
    console.error(e);
    res.status(500).json({ error: '그룹 생성 중 오류가 발생했습니다.' });
  } finally {
    conn.release();
  }
});

// GET /api/community/groups/verify?code=xxx — 초대코드로 그룹 미리보기
router.get('/groups/verify', async (req, res) => {
  const { code } = req.query;
  if (!code?.trim()) return res.status(400).json({ error: '초대 코드를 입력해주세요.' });

  const [rows] = await pool.execute(`
    SELECT g.id, g.name, g.max_members, COUNT(gm.id) AS member_count
    FROM \`groups\` g
    LEFT JOIN group_members gm ON gm.group_id = g.id
    WHERE g.code = ?
    GROUP BY g.id, g.name, g.max_members
  `, [code.trim().toUpperCase()]);

  if (rows.length === 0) return res.status(404).json({ error: '존재하지 않는 초대 코드예요.' });

  const g = rows[0];
  res.json({ id: g.id, name: g.name, maxMembers: g.max_members, memberCount: Number(g.member_count) });
});

// POST /api/community/groups/join — 그룹 참여
router.post('/groups/join', async (req, res) => {
  const { code, nickname, memberId: existingMemberId } = req.body;
  if (!code?.trim() || !nickname?.trim()) {
    return res.status(400).json({ error: '초대 코드와 닉네임을 입력해주세요.' });
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    // 그룹 확인
    const [groups] = await conn.execute(
      'SELECT id, name, max_members FROM `groups` WHERE code = ?',
      [code.trim().toUpperCase()]
    );
    if (groups.length === 0) {
      await conn.rollback();
      return res.status(404).json({ error: '존재하지 않는 초대 코드예요.' });
    }
    const group = groups[0];

    // 인원 초과 확인
    const [countRows] = await conn.execute(
      'SELECT COUNT(*) AS cnt FROM group_members WHERE group_id = ?',
      [group.id]
    );
    if (countRows[0].cnt >= group.max_members) {
      await conn.rollback();
      return res.status(409).json({ error: '그룹 정원이 가득 찼습니다.' });
    }

    // 기존 memberId 재사용 또는 새 멤버 생성
    let memberId = Number(existingMemberId) || 0;
    if (memberId) {
      const [rows] = await conn.execute('SELECT id FROM members WHERE id = ?', [memberId]);
      if (rows.length === 0) memberId = 0;
    }
    if (!memberId) {
      const [memberResult] = await conn.execute(
        'INSERT INTO members (nickname) VALUES (?)',
        [nickname.trim()]
      );
      memberId = memberResult.insertId;
    }

    // 이미 참여 중인지 확인
    const [existing] = await conn.execute(
      'SELECT id FROM group_members WHERE group_id = ? AND member_id = ?',
      [group.id, memberId]
    );
    if (existing.length > 0) {
      await conn.rollback();
      return res.status(409).json({ error: '이미 참여 중인 그룹입니다.' });
    }

    await conn.execute(
      'INSERT INTO group_members (group_id, member_id, nickname, is_creator) VALUES (?, ?, ?, 0)',
      [group.id, memberId, nickname.trim()]
    );

    await conn.commit();
    res.status(201).json({ groupId: group.id, name: group.name, memberId });
  } catch (e) {
    await conn.rollback();
    console.error(e);
    res.status(500).json({ error: '그룹 참여 중 오류가 발생했습니다.' });
  } finally {
    conn.release();
  }
});

// DELETE /api/community/groups/:groupId/leave — 그룹 나가기
router.delete('/groups/:groupId/leave', async (req, res) => {
  const groupId  = Number(req.params.groupId);
  const memberId = Number(req.body.memberId);
  if (!groupId || !memberId) return res.status(400).json({ error: 'groupId와 memberId가 필요합니다.' });

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [existing] = await conn.execute(
      'SELECT id FROM group_members WHERE group_id = ? AND member_id = ?',
      [groupId, memberId]
    );
    if (existing.length === 0) {
      await conn.rollback();
      return res.status(404).json({ error: '해당 그룹의 멤버가 아닙니다.' });
    }

    await conn.execute(
      'DELETE FROM group_members WHERE group_id = ? AND member_id = ?',
      [groupId, memberId]
    );

    // 멤버가 0명이면 그룹 삭제
    const [countRows] = await conn.execute(
      'SELECT COUNT(*) AS cnt FROM group_members WHERE group_id = ?',
      [groupId]
    );
    if (countRows[0].cnt === 0) {
      await conn.execute('DELETE FROM `groups` WHERE id = ?', [groupId]);
    }

    await conn.commit();
    res.json({ ok: true });
  } catch (e) {
    await conn.rollback();
    console.error(e);
    res.status(500).json({ error: '그룹 나가기 중 오류가 발생했습니다.' });
  } finally {
    conn.release();
  }
});

module.exports = router;
