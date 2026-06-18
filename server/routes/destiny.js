const express = require('express');
const router = express.Router();
const { getRecordById, getDestinyByRecordId, updateDestinyUnlocked } = require('../db');

// 命运轨迹定价（mock）
// 第 0 段免费，其余每段 1 元，一次性全部解锁 3 元
const SEGMENT_PRICE = 100;     // 单段：1 元 = 100 分
const BUNDLE_PRICE = 300;      // 全部：3 元 = 300 分

// mock 支付：简单校验 payToken，实际项目接微信支付
// 这里 payToken = 'mock_pay_ok' 视为支付成功
function mockPay(payToken, amount) {
  if (payToken === 'mock_pay_ok') return { ok: true, transactionId: 'MOCK-' + Date.now() };
  // demo 模式：任何非空 token 都放行，方便前端调试
  if (payToken && payToken.startsWith('demo_')) return { ok: true, transactionId: 'DEMO-' + Date.now() };
  return { ok: false, error: '支付未完成' };
}

// GET /api/destiny/:id
// 获取命运轨迹，未解锁的段落只返回元信息（title + locked），不返回 text
router.get('/:id', (req, res) => {
  try {
    const { id } = req.params;
    // id 可以是 record_id 或 destiny_id (DST-xxx)
    let destiny = null;
    if (id.startsWith('DST-')) {
      const recordId = id.slice(4);
      destiny = getDestinyByRecordId(recordId);
    } else {
      destiny = getDestinyByRecordId(id);
    }

    if (!destiny) {
      return res.status(404).json({ error: '命运轨迹不存在' });
    }

    const unlocked = new Set(destiny.unlockedIndices);
    const segments = destiny.segments.map((seg, i) => {
      if (unlocked.has(i)) {
        return { ...seg, index: i, locked: false };
      }
      return {
        index: i,
        title: seg.title,
        emoji: seg.emoji,
        bg: seg.bg,
        locked: true,
        price: SEGMENT_PRICE
      };
    });

    const allUnlocked = segments.every(s => !s.locked);
    return res.json({
      id: destiny.id,
      recordId: destiny.recordId,
      segments,
      totalSegments: segments.length,
      unlockedCount: segments.filter(s => !s.locked).length,
      allUnlocked,
      bundlePrice: BUNDLE_PRICE,
      segmentPrice: SEGMENT_PRICE
    });
  } catch (err) {
    console.error('[destiny/:id] error:', err);
    return res.status(500).json({ error: '服务器内部错误' });
  }
});

// POST /api/destiny/unlock
// body: { recordId, index?, payToken, mode: 'single' | 'bundle' }
// mode=single 时 index 必填；mode=bundle 时解锁全部
router.post('/unlock', (req, res) => {
  try {
    const { recordId, index, payToken, mode } = req.body || {};
    if (!recordId) {
      return res.status(400).json({ error: '缺少 recordId' });
    }

    const destiny = getDestinyByRecordId(recordId);
    if (!destiny) {
      return res.status(404).json({ error: '命运轨迹不存在' });
    }

    const total = destiny.segments.length;
    const currentUnlocked = new Set(destiny.unlockedIndices);

    if (mode === 'bundle') {
      // 一次性解锁全部
      const needPay = !currentUnlocked.has(0) || currentUnlocked.size < total;
      // 已经全解锁就不用再付
      if (currentUnlocked.size >= total) {
        return res.json({ ok: true, alreadyUnlocked: true, unlockedIndices: Array.from(currentUnlocked).sort((a, b) => a - b) });
      }
      const pay = mockPay(payToken, BUNDLE_PRICE);
      if (!pay.ok) {
        return res.status(402).json({ error: '支付失败', detail: pay.error });
      }
      const all = Array.from({ length: total }, (_, i) => i);
      updateDestinyUnlocked(recordId, all);
      return res.json({
        ok: true,
        transactionId: pay.transactionId,
        unlockedIndices: all,
        amount: BUNDLE_PRICE
      });
    }

    // 单段解锁
    const idx = parseInt(index, 10);
    if (Number.isNaN(idx) || idx < 0 || idx >= total) {
      return res.status(400).json({ error: '无效的段落索引' });
    }
    if (currentUnlocked.has(idx)) {
      return res.json({ ok: true, alreadyUnlocked: true, unlockedIndices: Array.from(currentUnlocked).sort((a, b) => a - b) });
    }
    // 第 0 段免费
    if (idx === 0) {
      currentUnlocked.add(0);
      const arr = Array.from(currentUnlocked).sort((a, b) => a - b);
      updateDestinyUnlocked(recordId, arr);
      return res.json({ ok: true, free: true, unlockedIndices: arr });
    }
    const pay = mockPay(payToken, SEGMENT_PRICE);
    if (!pay.ok) {
      return res.status(402).json({ error: '支付失败', detail: pay.error });
    }
    currentUnlocked.add(idx);
    const arr = Array.from(currentUnlocked).sort((a, b) => a - b);
    updateDestinyUnlocked(recordId, arr);
    return res.json({
      ok: true,
      transactionId: pay.transactionId,
      unlockedIndices: arr,
      amount: SEGMENT_PRICE
    });
  } catch (err) {
    console.error('[destiny/unlock] error:', err);
    return res.status(500).json({ error: '服务器内部错误' });
  }
});

module.exports = router;
