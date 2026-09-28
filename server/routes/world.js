// 世界脉搏（v2）：本阶段不做跨用户共享（handoff §4.5）。
// 不再展示任何他人原话片段；只返回累计放生数与最近出发的水域/时间（无用户文本）。
const express = require('express');
const router = express.Router();
const db = require('../db');

router.get('/pulse', (req, res) => {
  try {
    const d = db.getDb();
    const total = d.prepare(`SELECT COUNT(*) AS c FROM journeys`).get().c;
    const recent = d.prepare(`
      SELECT water, created_at FROM journeys ORDER BY created_at DESC LIMIT 12
    `).all().map(r => ({ water: r.water, ts: r.created_at }));
    res.json({ total, recent, serverTime: Date.now() });
  } catch (err) {
    console.error('[world/pulse]', err.message);
    res.status(500).json({ error: 'world pulse failed' });
  }
});

module.exports = router;
