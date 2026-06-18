const express = require('express');
const router = express.Router();
const { CREATURES, WATERS, SIGNS } = require('../data');
const { insertRecord } = require('../db');

function pad4(n) {
  return String(n).padStart(4, '0');
}

function generateId() {
  const d = new Date();
  const ymd =
    d.getFullYear().toString() +
    String(d.getMonth() + 1).padStart(2, '0') +
    String(d.getDate()).padStart(2, '0');
  const rand = pad4(Math.floor(Math.random() * 10000));
  return `CRSB-${ymd}-${rand}`;
}

function pickRandomSign(creature) {
  const signs = SIGNS[creature];
  return signs[Math.floor(Math.random() * signs.length)];
}

function calcReplyAt(feedbackTime, feedbackDate) {
  const now = Date.now();
  const HOUR = 60 * 60 * 1000;
  const DAY = 24 * HOUR;
  switch (feedbackTime) {
    case '24h':
      return now + DAY;
    case '3d':
      return now + 3 * DAY;
    case '7d':
      return now + 7 * DAY;
    case 'custom':
      if (feedbackDate) {
        const t = new Date(feedbackDate).getTime();
        if (!Number.isNaN(t)) return t;
      }
      return now + DAY;
    default:
      return now + DAY;
  }
}

function feedbackLabelOf(feedbackTime, feedbackDate) {
  switch (feedbackTime) {
    case '24h':
      return '24 小时后';
    case '3d':
      return '3 天后';
    case '7d':
      return '7 天后';
    case 'custom':
      return feedbackDate || '自定义时间';
    default:
      return '24 小时后';
  }
}

router.post('/', (req, res) => {
  try {
    let { openid, creature, water, feeling, feedbackTime, feedbackDate } = req.body || {};

    // 网页版没有微信 openid，未传时自动生成一个匿名用户ID
    if (!openid) {
      openid = `web-user-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
    }
    if (!creature || !CREATURES[creature]) {
      return res.status(400).json({ error: '无效的生物类型' });
    }
    if (!water || !WATERS[water]) {
      return res.status(400).json({ error: '无效的水域' });
    }
    if (!feeling || !String(feeling).trim()) {
      return res.status(400).json({ error: '请填写你的感受' });
    }

    const id = generateId();
    const sign = pickRandomSign(creature);
    const createdAt = Date.now();
    const replyAt = calcReplyAt(feedbackTime, feedbackDate);
    const feedbackLabel = feedbackLabelOf(feedbackTime, feedbackDate);

    insertRecord({
      id,
      openid,
      creature,
      water,
      feeling: String(feeling).trim(),
      feedback_label: feedbackLabel,
      sign,
      created_at: createdAt,
      reply_at: replyAt
    });

    return res.json({
      id,
      creature,
      creatureName: CREATURES[creature].name,
      creatureEmoji: CREATURES[creature].emoji,
      water,
      waterName: WATERS[water].name,
      waterType: WATERS[water].type,
      feeling: String(feeling).trim(),
      sign,
      feedbackLabel,
      createdAt,
      replyAt
    });
  } catch (err) {
    console.error('[release] error:', err);
    return res.status(500).json({ error: '服务器内部错误' });
  }
});

module.exports = router;
