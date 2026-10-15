// 赛博放生 · 业务 HTTP 通信入口（edge）
//
// 这里是 HTTP 层的薄壳：解析输入、调用 command/query、把结果映射成
// 共享契约里固定的状态码。**不含业务逻辑**——所有权判断、状态迁移、
// 幂等、提交都在 Host（commands/queries/workflows/commits）里。
//
// 归属纪律：所有读写都校验 req.ownerKey；他人或猜到的 ID 一律 404。
// 读取 API 绝不触发模型生成。

const express = require('express');
const { httpStatusFor, toErrorDto } = require('../../shared/contracts/errors');
const { CREATURES, WATERS } = require('../../shared/contracts/vocabulary');

/**
 * 幂等键来源：优先 Idempotency-Key 头，其次 body 里的 requestId。
 * 两者都归一进 input，由契约层的 parseXxxCommand 统一校验。
 */
function requestIdOf(req) {
  return req.get('Idempotency-Key') || req.body?.requestId || null;
}

function withRequestId(req) {
  const rid = requestIdOf(req);
  return rid ? { ...(req.body || {}), requestId: rid } : (req.body || {});
}

function createApiRouter(runtime) {
  const router = express.Router();
  const { commands, queries } = runtime;

  // ======== 放生 / 建程 ========
  // POST /api/release：先持久化并立即返回 preparing 回执；
  // 首个模型调用在后台 opening 任务完成，不阻塞可见成功状态。
  router.post('/release', (req, res) => {
    try {
      const input = withRequestId(req);
      const r = commands.release.execute({
        ownerKey: req.ownerKey,
        input
      });
      if (!r.ok) return res.status(httpStatusFor(r.code)).json(toErrorDto(r.code));
      return res.json({
        ok: true,
        journeyId: r.journeyId,
        status: r.status,
        replayed: !!r.replayed,
        creature: {
          id: r.creatureId,
          species: r.species,
          name: CREATURES[r.species]?.name || r.species,
          emoji: CREATURES[r.species]?.emoji || '🐚',
          isNew: !input.creatureId
        },
        water: r.water,
        waterName: WATERS[r.water]?.name || r.water,
        tone: r.tone,
        createdAt: r.createdAt,
        serverTime: r.serverTime
      });
    } catch (err) {
      console.error('[release]', err.message);
      return res.status(500).json(toErrorDto('internal_error'));
    }
  });

  // ======== 本程视图 ========
  // GET /api/journey/:id
  router.get('/journey/:id', (req, res) => {
    try {
      const view = queries.getJourneyView({ ownerKey: req.ownerKey, journeyId: req.params.id });
      if (!view) return res.status(404).json(toErrorDto('journey_not_found'));
      return res.json({ ok: true, journey: view });
    } catch (err) {
      console.error('[journey/:id]', err.message);
      return res.status(500).json(toErrorDto('internal_error'));
    }
  });

  // GET /api/journey/:id/timeline —— 仅结束后开放
  router.get('/journey/:id/timeline', (req, res) => {
    try {
      const r = queries.getJourneyTimeline({ ownerKey: req.ownerKey, journeyId: req.params.id });
      if (!r.ok) {
        return res.status(httpStatusFor(r.code)).json(toErrorDto(r.code, r.message));
      }
      return res.json({ ok: true, timeline: r.timeline });
    } catch (err) {
      console.error('[journey/timeline]', err.message);
      return res.status(500).json(toErrorDto('internal_error'));
    }
  });

  // ======== 回应信号 ========
  // POST /api/journey/:id/reply
  // 必须显式带 signalMessageId 或 encounterId（阶段 C.3）
  router.post('/journey/:id/reply', (req, res) => {
    try {
      const r = commands.replyToSignal.execute({
        ownerKey: req.ownerKey,
        journeyId: req.params.id,
        input: withRequestId(req)
      });
      if (!r.ok) return res.status(httpStatusFor(r.code)).json(toErrorDto(r.code));
      return res.json({
        ok: true,
        ontime: r.ontime,
        late: !!r.late,
        encounterId: r.encounterId || null,
        replayed: !!r.replayed,
        message: r.message || null
      });
    } catch (err) {
      console.error('[journey/reply]', err.message);
      return res.status(500).json(toErrorDto('internal_error'));
    }
  });

  // ======== 语气偏好 ========
  // POST /api/journey/:id/tone
  router.post('/journey/:id/tone', (req, res) => {
    try {
      const r = commands.setTone.execute({
        ownerKey: req.ownerKey, journeyId: req.params.id, input: req.body || {}
      });
      if (!r.ok) return res.status(httpStatusFor(r.code)).json(toErrorDto(r.code));
      return res.json({ ok: true, tone: r.tone, replayed: !!r.replayed });
    } catch (err) {
      console.error('[journey/tone]', err.message);
      return res.status(500).json(toErrorDto('internal_error'));
    }
  });

  // ======== 结束旅程 ========
  // POST /api/journey/:id/end —— 立即生效，不等模型
  router.post('/journey/:id/end', (req, res) => {
    try {
      const r = commands.endJourney.execute({
        ownerKey: req.ownerKey, journeyId: req.params.id, input: req.body || {}
      });
      if (!r.ok) return res.status(httpStatusFor(r.code)).json(toErrorDto(r.code));
      return res.json({ ok: true, status: r.status, replayed: !!r.replayed });
    } catch (err) {
      console.error('[journey/end]', err.message);
      return res.status(500).json(toErrorDto('internal_error'));
    }
  });

  // ======== 列表 ========
  router.get('/journeys', (req, res) => {
    try { res.json({ ok: true, journeys: queries.listJourneys(req.ownerKey) }); }
    catch (err) { console.error('[journeys]', err.message); res.status(500).json(toErrorDto('internal_error')); }
  });

  router.get('/creatures', (req, res) => {
    try { res.json({ ok: true, creatures: queries.listCreatures(req.ownerKey) }); }
    catch (err) { console.error('[creatures]', err.message); res.status(500).json(toErrorDto('internal_error')); }
  });

  // ======== 世界脉搏 ========
  // 不做跨用户共享，不展示任何他人原话片段
  router.get('/world/pulse', (req, res) => {
    try {
      const p = queries.getPublicPulse();
      res.json({ total: p.total, recent: p.recent, serverTime: Date.now() });
    } catch (err) {
      console.error('[world/pulse]', err.message);
      res.status(500).json({ error: 'world pulse failed' });
    }
  });

  return router;
}

module.exports = { createApiRouter };
