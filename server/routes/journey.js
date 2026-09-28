// 赛博放生 · 旅程路由（v2）
//
// 归属纪律（handoff §4.4）：
// - 所有读取与写入都校验会话归属（req.ownerKey）；他人/猜到的旅程 ID 一律 404
// - 读取 API 绝不触发模型生成；页面是否打开不影响推进
// - 用户补给（回应信号）、语气偏好、结束旅程都是显式写入口

const express = require('express');
const router = express.Router();
const orchestrator = require('../orchestrator');

// GET /api/journey/:id —— 本程状态 + 已寄出的信号/来信（只读）
router.get('/:id', (req, res) => {
  try {
    const view = orchestrator.getJourneyView({ ownerKey: req.ownerKey, journeyId: req.params.id });
    if (!view) return res.status(404).json({ ok: false, error: '旅程不存在' });
    return res.json({ ok: true, journey: view });
  } catch (err) {
    console.error('[journey/:id] error:', err);
    return res.status(500).json({ ok: false, error: '服务器内部错误' });
  }
});

// POST /api/journey/:id/reply —— 回应信号（body: {text}）
router.post('/:id/reply', (req, res) => {
  try {
    const r = orchestrator.replyToSignal({
      ownerKey: req.ownerKey, journeyId: req.params.id, text: req.body?.text
    });
    if (!r.ok) {
      const status = r.code === 'journey_not_found' ? 404 : (r.code === 'journey_ended' ? 409 : 400);
      return res.status(status).json({ ok: false, code: r.code, message: r.message });
    }
    return res.json({ ok: true, ontime: r.ontime, message: r.message || null });
  } catch (err) {
    console.error('[journey/reply] error:', err);
    return res.status(500).json({ ok: false, error: '服务器内部错误' });
  }
});

// POST /api/journey/:id/tone —— 语气偏好（只影响未来；body: {tone}）
router.post('/:id/tone', (req, res) => {
  try {
    const r = orchestrator.setTone({
      ownerKey: req.ownerKey, journeyId: req.params.id, tone: req.body?.tone
    });
    if (!r.ok) {
      const status = r.code === 'journey_not_found' ? 404 : 400;
      return res.status(status).json({ ok: false, code: r.code });
    }
    return res.json({ ok: true, tone: r.tone });
  } catch (err) {
    console.error('[journey/tone] error:', err);
    return res.status(500).json({ ok: false, error: '服务器内部错误' });
  }
});

// POST /api/journey/:id/end —— 用户主动结束本程（立即生效，不等模型）
router.post('/:id/end', (req, res) => {
  try {
    const r = orchestrator.endJourney({ ownerKey: req.ownerKey, journeyId: req.params.id });
    if (!r.ok) {
      const status = r.code === 'journey_not_found' ? 404 : 409;
      return res.status(status).json({ ok: false, code: r.code });
    }
    return res.json({ ok: true });
  } catch (err) {
    console.error('[journey/end] error:', err);
    return res.status(500).json({ ok: false, error: '服务器内部错误' });
  }
});

module.exports = router;
