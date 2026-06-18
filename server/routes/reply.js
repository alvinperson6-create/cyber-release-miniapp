const express = require('express');
const router = express.Router();
const { getRecordById } = require('../db');

// GET /api/reply/:id
router.get('/:id', (req, res) => {
  try {
    const { id } = req.params;
    const row = getRecordById(id);
    if (!row) {
      return res.status(404).json({ error: '记录不存在' });
    }

    if (!row.reply_text) {
      return res.json({
        ready: false,
        replyAt: row.reply_at
      });
    }

    return res.json({
      ready: true,
      bg: row.reply_bg,
      emoji: row.reply_emoji,
      text: row.reply_text,
      createdAt: row.reply_created_at
    });
  } catch (err) {
    console.error('[reply/:id] error:', err);
    return res.status(500).json({ error: '服务器内部错误' });
  }
});

module.exports = router;
