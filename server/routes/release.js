// 赛博放生 · 放生/建程路由（v2）
// POST /api/release：先持久化并立即返回 preparing 回执；
// 首个模型调用在后台 opening 任务里完成，不阻塞可见成功状态（handoff §4.3）。
// 不再提供固定终局回信时间（24h/3d/7d/自选全部下线）。

const express = require('express');
const router = express.Router();
const { CREATURES, WATERS } = require('../data');
const orchestrator = require('../orchestrator');

const ERROR_STATUS = {
  invalid_species: 400, invalid_water: 400, empty_feeling: 400,
  feeling_too_long: 400, creature_not_found: 404, species_mismatch: 400,
  journey_disabled: 503
};

router.post('/', (req, res) => {
  try {
    const { creatureId, water, feeling, tone } = req.body || {};
    const species = req.body?.species || req.body?.creature; // creature 为旧字段名别名
    const r = orchestrator.startJourney({
      ownerKey: req.ownerKey, creatureId, species, water, feeling, tone
    });
    if (!r.ok) {
      return res.status(ERROR_STATUS[r.code] || 400).json({ ok: false, code: r.code });
    }
    const { journey, creature } = r;
    return res.json({
      ok: true,
      journeyId: journey.id,
      status: journey.status, // preparing
      creature: {
        id: creature.id,
        species: creature.species,
        name: CREATURES[creature.species].name,
        emoji: CREATURES[creature.species].emoji,
        isNew: !creatureId
      },
      water: journey.water,
      waterName: WATERS[journey.water].name,
      tone: journey.tone,
      createdAt: journey.created_at,
      serverTime: Date.now()
    });
  } catch (err) {
    console.error('[release] error:', err);
    return res.status(500).json({ ok: false, error: '服务器内部错误' });
  }
});

module.exports = router;
