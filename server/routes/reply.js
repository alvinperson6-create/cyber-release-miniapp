const express = require('express');
const router = express.Router();
const { getRecordById, updateReply, insertDestiny, getDestinyByRecordId } = require('../db');
const { generateReply, generateDestiny, isAIEnabled } = require('../ai');

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

// POST /api/reply/generate
// 内部调用 AI 生成回信 + 命运轨迹，写入 DB
// body: { id: 记录ID }
router.post('/generate', async (req, res) => {
  try {
    const { id } = req.body || {};
    if (!id) {
      return res.status(400).json({ error: '缺少 id' });
    }
    const row = getRecordById(id);
    if (!row) {
      return res.status(404).json({ error: '记录不存在' });
    }

    // 1. 生成 AI 回信（若已存在则跳过）
    let reply;
    if (row.reply_text) {
      reply = { bg: row.reply_bg, emoji: row.reply_emoji, text: row.reply_text };
    } else {
      reply = await generateReply({
        feeling: row.feeling,
        creature: row.creature,
        water: row.water
      });
      updateReply(id, reply);
    }

    // 2. 生成命运轨迹（若已存在则跳过）
    let destiny = getDestinyByRecordId(id);
    if (!destiny) {
      const segments = await generateDestiny({
        feeling: row.feeling,
        creature: row.creature,
        water: row.water
      });
      insertDestiny({
        id: `DST-${id}`,
        recordId: id,
        openid: row.openid,
        segments
      });
      destiny = getDestinyByRecordId(id);
    }

    return res.json({
      ok: true,
      reply,
      destinyId: destiny.id,
      aiEnabled: isAIEnabled()
    });
  } catch (err) {
    console.error('[reply/generate] error:', err);
    return res.status(500).json({ error: '服务器内部错误', detail: err.message });
  }
});

module.exports = router;
