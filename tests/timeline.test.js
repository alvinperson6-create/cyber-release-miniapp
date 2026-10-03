// 旅程回顾时间线测试：结束后才开放、全量串线、归属、未落定标记、零模型调用
const { test } = require('node:test');
const assert = require('node:assert');
const { createWorld, proposalJson } = require('./helpers/world');

function makeWorld(tag) {
  return createWorld({
    tag,
    llm: {
      opening: () => ({ goal: '学会量力而行地帮忙', encounter: proposalJson({ title: '螃蟹的代班请求' }) }),
      proposal: () => proposalJson({ title: '湖长的联欢会' }),
      settlement: () => ({
        narrative: '它答应了代班，累但被需要，班次翻倍。',
        facts: [{ kind: 'relationship', content: '螃蟹成了它的朋友' }, { kind: 'consequence', content: '它一夜没睡' }],
        mechanism_card: { pressure: '代班请求', dilemma: '接不接', choice_cost: '睡眠', lasting_consequence: '成了最好说话的那个' }
      }),
      signal: () => ({ text: '螃蟹想让我代一晚班，我有点犹豫。' }),
      letter: (ctx) => ctx && ctx.system.includes('最后一封')
        ? { title: '道别', text: '这一程到这里，谢谢你那句可以答应。' }
        : { title: '第一夜', text: '我替螃蟹值了一晚班，鳍都是僵的。' }
    },
    jev: { decide: ['send_signal', 'a1', 'a1'], contact: ['continue', 'letter', 'final_letter'] }
  });
}

function view(w, jid) { return w.orchestrator.getJourneyView({ ownerKey: 'o1', journeyId: jid }); }

test('进行中不开放（保护它自己选择来信时机的意义）；结束后全量串线', async () => {
  const world = makeWorld('tl1');
  const r = world.orchestrator.startJourney({ ownerKey: 'o1', species: 'koi', water: 'xihu', feeling: '谁找我帮忙都答应', tone: 'balanced' });
  // 进行中：拒绝展开
  const during = world.orchestrator.getJourneyTimeline({ ownerKey: 'o1', journeyId: r.journey.id });
  assert.equal(during.ok, false);
  assert.equal(during.code, 'journey_not_finished');

  // 走完整程：信号→补给→行动→阶段信→继续→收束
  await world.drain(50, { stopWhen: () => { const v = view(world, r.journey.id); return !!(v.pendingSignal && !v.pendingSignal.replied); } });
  world.orchestrator.replyToSignal({ ownerKey: 'o1', journeyId: r.journey.id, text: '这次可以答应' });
  await world.scheduler.tick({ budget: 3 });
  await world.drain(80);
  for (let i = 0; i < 12; i++) {
    world.step(3600e3);
    if (!world.db.getMessages(r.journey.id).some(m => m.sentAt > world.now())) break;
  }
  assert.equal(view(world, r.journey.id).status, 'ended_natural');

  const t = world.orchestrator.getJourneyTimeline({ ownerKey: 'o1', journeyId: r.journey.id });
  assert.equal(t.ok, true);
  const kinds = t.timeline.nodes.map(n => n.kind);
  assert.equal(kinds[0], 'opening', '开局在最先');
  assert.equal(kinds[kinds.length - 1], 'ending', '收束在最后');
  assert.ok(kinds.includes('encounter') && kinds.includes('signal') && kinds.includes('user_reply') && kinds.includes('letter') && kinds.includes('final_letter'), '遭遇与消息全部成线: ' + kinds.join(','));
  // 时间单调不减
  for (let i = 1; i < t.timeline.nodes.length; i++) {
    assert.ok(t.timeline.nodes[i].at >= t.timeline.nodes[i - 1].at, '时间线按时间排序');
  }
  // 遭遇节点含 JEV 选择与后果
  const enc = t.timeline.nodes.find(n => n.kind === 'encounter');
  assert.equal(enc.settled, true);
  assert.equal(enc.decisionSource, 'jev');
  assert.ok(enc.chosenAction && enc.narrative);
  assert.ok(enc.outcomeFacts.some(f => f.includes('螃蟹')));
  // 开局节点含目标与动机
  const opening = t.timeline.nodes[0];
  assert.ok(opening.goal.includes('量力而行'));
  assert.equal(opening.motivation.rawText, '谁找我帮忙都答应');
  // 收束原因
  assert.equal(t.timeline.nodes.at(-1).reason, 'natural');
});

test('归属校验：他人拿不到时间线；纯读取零模型调用', async () => {
  const world = makeWorld('tl2');
  const r = world.orchestrator.startJourney({ ownerKey: 'o1', species: 'koi', water: 'xihu', feeling: '烦', tone: 'balanced' });
  await world.drain(80);
  world.orchestrator.endJourney({ ownerKey: 'o1', journeyId: r.journey.id });
  assert.equal(world.orchestrator.getJourneyTimeline({ ownerKey: 'someone-else', journeyId: r.journey.id }).code, 'journey_not_found');
  const callsBefore = world.db.countModelCalls(r.journey.id);
  const t = world.orchestrator.getJourneyTimeline({ ownerKey: 'o1', journeyId: r.journey.id });
  assert.equal(t.ok, true);
  assert.equal(world.db.countModelCalls(r.journey.id), callsBefore, 'timeline 触发零模型调用');
});

test('用户中途结束：未落定的遭遇如实标记', async () => {
  const world = makeWorld('tl3');
  const r = world.orchestrator.startJourney({ ownerKey: 'o1', species: 'turtle', water: 'baikal', feeling: '太慢', tone: 'balanced' });
  await world.drain(50, { stopWhen: () => { const v = view(world, r.journey.id); return !!(v.pendingSignal && !v.pendingSignal.replied); } });
  world.orchestrator.endJourney({ ownerKey: 'o1', journeyId: r.journey.id });
  const t = world.orchestrator.getJourneyTimeline({ ownerKey: 'o1', journeyId: r.journey.id });
  assert.equal(t.ok, true);
  const enc = t.timeline.nodes.find(n => n.kind === 'encounter');
  assert.equal(enc.settled, false);
  assert.ok(enc.unresolvedNote.includes('还没落定'));
  assert.equal(t.timeline.nodes.at(-1).reason, 'user');
});

// HTTP 层：403 进行中 / 200 结束后 / 404 越权
const { test: t2 } = require('node:test');
t2('HTTP：timeline 端点状态码与归属', async () => {
  const world = makeWorld('tl4');
  const http = require('node:http');
  const express = require('../server/node_modules/express');
  const { sessionMiddleware } = require('../server/session');
  const app = express();
  app.use(express.json());
  app.use('/api', sessionMiddleware);
  app.use('/api/release', require('../server/routes/release'));
  app.use('/api/journey', require('../server/routes/journey'));
  const server = http.createServer(app);
  await new Promise(res => server.listen(0, res));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const rel = await fetch(`${base}/api/release`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ species: 'koi', water: 'xihu', feeling: '秘密', tone: 'balanced' }) });
    const cookie = (rel.headers.get('set-cookie') || '').split(';')[0];
    const { journeyId } = await rel.json();

    const during = await fetch(`${base}/api/journey/${journeyId}/timeline`, { headers: { Cookie: cookie } });
    assert.equal(during.status, 403);
    const duringBody = await during.json();
    assert.equal(duringBody.code, 'journey_not_finished');

    const foreign = await fetch(`${base}/api/journey/${journeyId}/timeline`);
    assert.equal(foreign.status, 404);

    const end = await fetch(`${base}/api/journey/${journeyId}/end`, { method: 'POST', headers: { Cookie: cookie } });
    assert.equal((await end.json()).ok, true);
    const ok = await fetch(`${base}/api/journey/${journeyId}/timeline`, { headers: { Cookie: cookie } });
    assert.equal(ok.status, 200);
    const body = await ok.json();
    assert.ok(body.timeline.nodes.length >= 2);
  } finally {
    server.closeAllConnections?.();
    await new Promise(res => server.close(res));
  }
});

// 收束信配图：任务不被收束取消，旅程结束后仍完成（非阻塞）
// 注：配图预算每程 1 张、先到先得——本场景去掉阶段来信，让收束信拿到预算
const { test: t3 } = require('node:test');
t3('收束信配图在旅程结束后仍生成并挂到信上', async () => {
  const world = makeWorld('tl5');
  // 用事件上限触发收束（contact#1=continue 后事件预算即满 → 直接收束信，无阶段来信）
  const ai = require('../server/ai');
  ai.generateReplyImage = async () => '/images/letter-test.png';
  process.env.J_MAX_EVENTS = '2';
  try {
  const r = world.orchestrator.startJourney({ ownerKey: 'o1', species: 'koi', water: 'xihu', feeling: '谁找我帮忙都答应', tone: 'balanced' });
  await world.drain(80);
  for (let i = 0; i < 12; i++) {
    world.step(3600e3);
    if (!world.db.getMessages(r.journey.id).some(m => m.sentAt > world.now())) break;
  }
  assert.equal(view(world, r.journey.id).status, 'ended_natural');
  // 无阶段来信时收束信持有配图预算
  assert.ok(!world.db.getMessages(r.journey.id).some(m => m.kind === 'letter'), '前置：无阶段来信');
  const scheduled = world.db.hasOpenTask(r.journey.id, 'image')
    || world.db.getDb().prepare(`SELECT COUNT(*) c FROM tasks WHERE journey_id = ? AND kind = 'image' AND status = 'done'`).get(r.journey.id).c > 0;
  assert.ok(scheduled, 'image task scheduled and survives ending');
  await world.drain(10);
  const fin = world.db.getMessages(r.journey.id).find(m => m.kind === 'final_letter');
  assert.equal(fin.image, '/images/letter-test.png');
  assert.equal(fin.imageStatus, 'done');
  } finally {
    delete process.env.J_MAX_EVENTS;
  }
});
