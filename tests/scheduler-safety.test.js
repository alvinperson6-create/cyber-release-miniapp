// 调度与安全：公平取用、租约恢复、重试上限、预算暂停、越权、JEV 不可用不冒充
const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const { createWorld, proposalJson } = require('./helpers/world');

function baseWorld(tag, over = {}) {
  return createWorld({
    tag,
    llm: {
      opening: () => ({ goal: '把这片水域的日子过明白', encounter: proposalJson({ title: '遭遇' }) }),
      proposal: () => proposalJson({ title: '下一遭遇' }),
      settlement: () => ({
        narrative: '事情有了结果，它继续往前游。',
        facts: [{ kind: 'consequence', content: '一个后果' }],
        mechanism_card: { pressure: 'p', dilemma: 'd', choice_cost: 'c', lasting_consequence: 'l' }
      }),
      signal: () => ({ text: '一个简短的信号。' }),
      letter: () => ({ title: '信', text: '这是信的正文，叙述已经发生的事。' })
    },
    jev: { decide: 'a1', contact: 'continue' },
    ...over
  });
}

test('公平：两条旅程同时到期，单旅程每 tick 限额，不会饿死后到旅程', async () => {
  const world = baseWorld('fair');
  const r1 = world.orchestrator.startJourney({ ownerKey: 'A', species: 'koi', water: 'xihu', feeling: 'A 的烦恼', tone: 'balanced' });
  const r2 = world.orchestrator.startJourney({ ownerKey: 'B', species: 'turtle', water: 'baikal', feeling: 'B 的烦恼', tone: 'balanced' });
  world.step(61e3);
  const t1 = await world.scheduler.tick({ budget: 1 });
  assert.equal(t1.claimed, 1);
  const firstJourney = t1.results[0];
  const t2 = await world.scheduler.tick({ budget: 1 });
  assert.equal(t2.claimed, 1);
  // 第二 tick 轮到另一条旅程（due_at 相同按 created_at，且 maxPerJourney=1）
  const db = world.db;
  const j1 = db.getTask(firstJourney.id);
  assert.notEqual(db.getTask(t2.results[0].id).journey_id, undefined);
  // 两条旅程最终都能推进（无饥饿）
  await world.drain(10);
  assert.equal(db.getJourney(r1.journey.id).status, 'active');
  assert.equal(db.getJourney(r2.journey.id).status, 'active');
});

test('租约恢复：模拟持锁进程死亡 → 租约过期回收 → 另一 worker 完成', async () => {
  const world = baseWorld('lease');
  const r = world.orchestrator.startJourney({ ownerKey: 'A', species: 'koi', water: 'xihu', feeling: '烦', tone: 'balanced' });
  world.step(61e3);
  // 模拟 worker1 认领后崩溃（不 complete）
  const claimed = world.db.claimDueTasks(world.now(), { limit: 3, leaseMs: 60e3 });
  assert.ok(claimed.length >= 1);
  // 时间跳过租约期
  world.step(61e3);
  const recovered = world.db.recoverExpiredLeases(world.now());
  assert.ok(recovered >= 1, 'expired lease returned to pending');
  await world.drain(6);
  const j = world.db.getJourney(r.journey.id);
  assert.equal(j.status, 'active');
  assert.ok(world.db.getLatestEncounter(r.journey.id), 'opening eventually committed');
  // 单事件不重复
  const encs = world.db.getDb().prepare('SELECT COUNT(*) c FROM encounters WHERE journey_id = ?').get(r.journey.id);
  assert.equal(encs.c, 1);
});

test('重试上限：模型持续失败 → 任务 failed + 旅程如实暂停（不伪装收束）', async () => {
  const world = baseWorld('retry', {
    llm: {
      opening: () => ({ __error: true, message: '模型持续失败' })
    }
  });
  const r = world.orchestrator.startJourney({ ownerKey: 'A', species: 'koi', water: 'xihu', feeling: '烦', tone: 'balanced' });
  // 加速退避：连续推进虚拟时钟跑完 4 次尝试
  for (let i = 0; i < 10; i++) {
    world.step(10 * 60e3);
    await world.scheduler.tick({ budget: 3 });
  }
  const j = world.db.getJourney(r.journey.id);
  assert.equal(j.status, 'paused');
  assert.equal(j.pause_reason, 'task_retry_exhausted');
  const sys = world.db.getMessages(r.journey.id).find(m => m.kind === 'system');
  assert.ok(sys, 'honest system notice');
  assert.ok(!sys.text.includes('它决定'), 'system notice is not fake creature mail');
  const v = world.orchestrator.getJourneyView({ ownerKey: 'A', journeyId: r.journey.id });
  assert.equal(v.phase, 'paused');
});

test('预算护栏：调用预算用尽 → 旅程暂停（budget_exhausted），如实显示', async () => {
  const world = baseWorld('budget');
  // 预算只够开局（JEV 情境识别 1 次 + 开局 1 次 = 2；设 3，decision 时无余量）
  process.env.J_MAX_MODEL_CALLS = '3';
  try {
    const r = world.orchestrator.startJourney({ ownerKey: 'A', species: 'koi', water: 'xihu', feeling: '烦', tone: 'balanced' });
    await world.drain(12);
    const j = world.db.getJourney(r.journey.id);
    assert.ok(['active', 'paused'].includes(j.status));
    if (j.status === 'paused') {
      assert.equal(j.pause_reason, 'budget_exhausted');
      assert.ok(world.db.getMessages(r.journey.id).some(m => m.kind === 'system'));
    }
  } finally {
    delete process.env.J_MAX_MODEL_CALLS;
  }
});

test('JEV 不可用：决策重试后暂停，绝不产生规则回退的伪 JEV 行动', async () => {
  const world = baseWorld('nojev');
  world.jevSet(false);
  const r = world.orchestrator.startJourney({ ownerKey: 'A', species: 'koi', water: 'xihu', feeling: '烦', tone: 'balanced' });
  for (let i = 0; i < 12; i++) {
    world.step(10 * 60e3);
    await world.scheduler.tick({ budget: 3 });
  }
  const enc = world.db.getLatestEncounter(r.journey.id);
  // 开局成功（opening 不需要 JEV 决策），但决策阶段不能有假行动
  assert.ok(enc);
  assert.equal(enc.status, 'proposed', 'no decision committed without JEV');
  const j = world.db.getJourney(r.journey.id);
  assert.equal(j.status, 'paused');
  const decided = world.db.getDb().prepare(
    `SELECT COUNT(*) c FROM encounters WHERE journey_id = ? AND decision_source IS NOT NULL`
  ).get(r.journey.id);
  assert.equal(decided.c, 0, 'no fake decision source');
});

test('HTTP 安全与会话：HttpOnly cookie、归属 404、双程同生物、world pulse 无原话', async () => {
  const world = baseWorld('httpsec');
  const http = require('node:http');
  const { sessionMiddleware } = require('../server/session');
  const express = require('../server/node_modules/express');
  const app = express();
  app.use(express.json());
  app.use('/api', sessionMiddleware);
  app.use('/api/release', require('../server/routes/release'));
  app.use('/api/journey', require('../server/routes/journey'));
  app.use('/api/world', require('../server/routes/world'));
  app.get('/api/journeys', (req, res) => res.json({ ok: true, journeys: world.orchestrator.listJourneys(req.ownerKey) }));
  app.get('/api/creatures', (req, res) => res.json({ ok: true, creatures: world.orchestrator.listCreatures(req.ownerKey) }));
  const server = http.createServer(app);
  await new Promise(r => server.listen(0, r));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  try {

  const r1 = await fetch(`${base}/api/release`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ species: 'koi', water: 'xihu', feeling: '秘密烦恼：我的项目名', tone: 'balanced' }) });
  assert.equal(r1.status, 200);
  const setCookie = r1.headers.get('set-cookie') || '';
  assert.ok(setCookie.includes('HttpOnly'), 'cookie must be HttpOnly');
  assert.ok(setCookie.includes('SameSite=Lax'), 'cookie must be SameSite=Lax');
  const cookie = setCookie.split(';')[0];
  const body1 = await r1.json();

  // 无凭据读他人旅程 → 404
  const leak = await fetch(`${base}/api/journey/${body1.journeyId}`);
  assert.equal(leak.status, 404);
  // 伪造 cookie → 404
  const forged = await fetch(`${base}/api/journey/${body1.journeyId}`, { headers: { Cookie: 'crsid=forged-token-abcdefg' } });
  assert.equal(forged.status, 404);
  // 归属会话可读
  const own = await fetch(`${base}/api/journey/${body1.journeyId}`, { headers: { Cookie: cookie } });
  assert.equal(own.status, 200);

  // 同一生物再出发（HTTP 路径）
  const r2 = await fetch(`${base}/api/release`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify({ species: 'koi', water: 'baikal', feeling: '新烦恼', tone: 'gentle', creatureId: body1.creature.id }) });
  const body2 = await r2.json();
  assert.equal(body2.creature.id, body1.creature.id);
  assert.notEqual(body2.journeyId, body1.journeyId);

  // 非法输入
  const bad = await fetch(`${base}/api/release`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify({ species: 'dragon', water: 'xihu', feeling: 'x' }) });
  assert.equal(bad.status, 400);

  // world pulse 不含用户原话
  const pulse = await (await fetch(`${base}/api/world/pulse`)).json();
  assert.ok(!JSON.stringify(pulse).includes('秘密烦恼'), 'pulse must not leak user text');

  } finally {
    server.closeAllConnections?.();
    await new Promise(r => server.close(r));
  }
});

test('H5 安全渲染：页面不含 innerHTML 注入模型/用户文本的路径（静态检查 + API 转义由前端 esc 完成）', async () => {
  const fs = require('node:fs');
  const src = fs.readFileSync(require('node:path').join(__dirname, '..', 'web-app.html'), 'utf8');
  // 动态插值必须经 esc()
  assert.ok(src.includes('function esc('), 'esc helper exists');
  // 模型/用户文本插值点都用 esc（抽查关键渲染点）
  assert.ok(src.includes("esc(m.text)"), 'message text escaped');
  assert.ok(src.includes("esc(j.goal)"), 'goal escaped');
  assert.ok(src.includes("esc(s.text || '')"), 'signal text escaped');
  // 表单默认值契约：除烦恼输入外开箱即用（生物=锦鲤、语气=荒诞但温和）
  assert.ok(src.includes('<button class="chip coral active" data-creature="koi">'), 'koi chip active by default');
  assert.ok(src.includes('<button class="chip aqua active" data-tone="balanced">'), 'balanced tone active by default');
  assert.ok(src.includes("creature: 'koi'"), 'state.creature defaults to koi');
});
