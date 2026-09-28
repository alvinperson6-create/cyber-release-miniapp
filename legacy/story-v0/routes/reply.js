const express = require('express');
const router = express.Router();
const { getRecordById } = require('../db');
const { isAIEnabled, getConfig } = require('../ai');
const { ensureStoryAndReply, getReplyTimeLabel } = require('../reply-generator');

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
      image: row.reply_image,
      createdAt: row.reply_created_at
    });
  } catch (err) {
    console.error('[reply/:id] error:', err);
    return res.status(500).json({ error: '服务器内部错误' });
  }
});

// POST /api/reply/generate
// 与调度器共用同一核心编排 ensureStoryAndReply（故事→落库冻结→派生回信→配图）
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

    const reply = await ensureStoryAndReply(row);
    const destiny = require('../db').getDestinyByRecordId(id);

    return res.json({
      ok: true,
      reply,
      destinyId: destiny ? destiny.id : null,
      semanticStatus: destiny ? destiny.semanticStatus : null,
      aiEnabled: isAIEnabled(),
      replyTimeLabel: getReplyTimeLabel(row.reply_at - row.created_at),
      config: { provider: getConfig().provider, model: getConfig().model }
    });
  } catch (err) {
    console.error('[reply/generate] error:', err);
    return res.status(500).json({ error: '服务器内部错误', detail: err.message });
  }
});

// POST /api/ai/debug
// 调试用：直接调用 AI，返回真实原始响应（不写库，不走模板）
// body: { feeling, creature, water } 任选其一
router.post('/debug', async (req, res) => {
  try {
    const { feeling, creature, water, prompt } = req.body || {};
    const ai = require('../ai');
    const messages = prompt
      ? [{ role: 'user', content: prompt }]
      : (() => {
          // 复用回信 prompt 构造
          const f = feeling || '今天有点累';
          const c = creature || 'koi';
          const w = water || 'baikal';
          // 这里复用 ai.js 内部 buildReplyPrompt
          const fn = require('../ai').generateReply;
          return null; // 占位：走下面分项
        })();

    if (prompt) {
      // 走最简模式：单条 user 消息
      const cfg = ai.getConfig();
      const url = cfg.baseUrl + '/chat/completions';
      const t0 = Date.now();
      const resp = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${cfg.apiKey}`
        },
        body: JSON.stringify({
          model: cfg.model,
          messages: [{ role: 'user', content: prompt }],
          temperature: 0.85,
          max_tokens: 200
        })
      });
      const text = await resp.text();
      let json = null;
      try { json = JSON.parse(text); } catch (e) {}
      return res.json({
        ok: resp.ok,
        status: resp.status,
        durationMs: Date.now() - t0,
        config: { provider: cfg.provider, model: cfg.model, baseUrl: cfg.baseUrl },
        raw: json,
        content: json?.choices?.[0]?.message?.content || null,
        rawText: text.slice(0, 2000)
      });
    }

    // 走真实业务路径：generateReply 不写库，只看返回值
    const reply = await ai.generateReply({ feeling, creature, water });
    return res.json({ ok: true, reply, aiEnabled: ai.isAIEnabled() });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;
