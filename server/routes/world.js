const express = require('express');
const router = express.Router();
const { getAllRecords } = require('../db');

// 世界脉搏：全球累计放生 + 最近匿名放生片段（不含身份信息）
router.get('/pulse', (req, res) => {
  try {
    const records = getAllRecords();
    const total = records.length;
    const recent = records
      .filter(r => r.feeling && r.feeling.trim())
      .sort((a, b) => b.created_at - a.created_at)
      .slice(0, 5)
      .map(r => ({
        creature: r.creature,
        water: r.water,
        feeling: r.feeling.length > 30 ? r.feeling.slice(0, 30) + '…' : r.feeling,
        ts: r.created_at
      }));
    res.json({ total, recent, serverTime: Date.now() });
  } catch (err) {
    console.error('[world/pulse]', err.message);
    res.status(500).json({ error: 'world pulse failed' });
  }
});

module.exports = router;
