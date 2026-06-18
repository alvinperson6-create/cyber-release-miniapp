const express = require('express');
const router = express.Router();
const { CREATURES, WATERS } = require('../data');
const { getRecordsByOpenid, getRecordById, getStats } = require('../db');

function formatRecord(r) {
  const now = Date.now();
  const replied = !!r.reply_text;
  const pending = !replied && r.reply_at <= now;
  let status;
  if (replied) status = 'replied';
  else if (pending) status = 'pending';
  else status = 'waiting';

  return {
    id: r.id,
    openid: r.openid,
    creature: r.creature,
    creatureName: CREATURES[r.creature] ? CREATURES[r.creature].name : r.creature,
    creatureEmoji: CREATURES[r.creature] ? CREATURES[r.creature].emoji : '',
    water: r.water,
    waterName: WATERS[r.water] ? WATERS[r.water].name : r.water,
    waterType: WATERS[r.water] ? WATERS[r.water].type : '',
    feeling: r.feeling,
    feedbackLabel: r.feedback_label,
    sign: r.sign,
    createdAt: r.created_at,
    replyAt: r.reply_at,
    status,
    reply: replied
      ? {
          bg: r.reply_bg,
          emoji: r.reply_emoji,
          text: r.reply_text,
          createdAt: r.reply_created_at
        }
      : null
  };
}

// GET /api/records?openid=xxx
router.get('/', (req, res) => {
  try {
    const openid = req.query.openid;
    if (!openid) {
      return res.status(400).json({ error: '缺少 openid 参数' });
    }
    const rows = getRecordsByOpenid(openid);
    const records = rows.map(formatRecord);
    const stats = getStats(openid);
    return res.json({ records, stats });
  } catch (err) {
    console.error('[records] error:', err);
    return res.status(500).json({ error: '服务器内部错误' });
  }
});

// GET /api/records/:id
router.get('/:id', (req, res) => {
  try {
    const { id } = req.params;
    const row = getRecordById(id);
    if (!row) {
      return res.status(404).json({ error: '记录不存在' });
    }
    return res.json(formatRecord(row));
  } catch (err) {
    console.error('[records/:id] error:', err);
    return res.status(500).json({ error: '服务器内部错误' });
  }
});

module.exports = router;
