const express = require('express');
const router = express.Router();
const { getRecordById, getDestinyByRecordId, updateDestinyUnlocked } = require('../db');

// 命运轨迹解锁方式：看广告
// 第 0 段免费，其余每段需看 1 次广告，一次性全部解锁需看 1 次广告
const AD_DURATION_MS = 15 * 1000;  // mock 广告时长 15 秒

// mock 看广告：校验 adToken，实际项目接入激励视频 SDK
// 这里 adToken = 'mock_ad_ok' 视为广告观看完成
// demo 模式：任何非空 token 都放行，方便前端调试
function mockWatchAd(adToken) {
  if (adToken === 'mock_ad_ok') return { ok: true, adId: 'AD-' + Date.now() };
  if (adToken && adToken.startsWith('demo_')) return { ok: true, adId: 'DEMO-AD-' + Date.now() };
  return { ok: false, error: '广告未完成观看' };
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
        unlockType: i === 0 ? 'free' : 'ad'
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
      adDurationMs: AD_DURATION_MS
    });
  } catch (err) {
    console.error('[destiny/:id] error:', err);
    return res.status(500).json({ error: '服务器内部错误' });
  }
});

// POST /api/destiny/unlock
// body: { recordId, index?, adToken, mode: 'single' | 'bundle' }
// mode=single 时 index 必填；mode=bundle 时看 1 次广告解锁全部
router.post('/unlock', (req, res) => {
  try {
    const { recordId, index, adToken, mode } = req.body || {};
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
      // 看一次广告解锁全部
      if (currentUnlocked.size >= total) {
        return res.json({ ok: true, alreadyUnlocked: true, unlockedIndices: Array.from(currentUnlocked).sort((a, b) => a - b) });
      }
      const ad = mockWatchAd(adToken);
      if (!ad.ok) {
        return res.status(403).json({ error: '广告未完成', detail: ad.error });
      }
      const all = Array.from({ length: total }, (_, i) => i);
      updateDestinyUnlocked(recordId, all);
      return res.json({
        ok: true,
        adId: ad.adId,
        unlockedIndices: all,
        adWatched: true
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
    // 其余段落看广告解锁
    const ad = mockWatchAd(adToken);
    if (!ad.ok) {
      return res.status(403).json({ error: '广告未完成', detail: ad.error });
    }
    currentUnlocked.add(idx);
    const arr = Array.from(currentUnlocked).sort((a, b) => a - b);
    updateDestinyUnlocked(recordId, arr);
    return res.json({
      ok: true,
      adId: ad.adId,
      unlockedIndices: arr,
      adWatched: true
    });
  } catch (err) {
    console.error('[destiny/unlock] error:', err);
    return res.status(500).json({ error: '服务器内部错误' });
  }
});

module.exports = router;
