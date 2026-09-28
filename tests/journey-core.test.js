// 旅程内核测试：开局 → JEV 决策 → 结算 → 事实/版本 → 下一遭遇承接 → 幂等
const { test } = require('node:test');
const assert = require('node:assert');
const { createWorld, proposalJson } = require('./helpers/world');

function makeWorld(over = {}) {
  return createWorld({
    tag: over.tag || 'core',
    llm: {
      opening: () => ({
        goal: '把每件帮完的忙都记在小贝壳上',
        encounter: proposalJson({ title: '螃蟹的代班请求' })
      }),
      proposal: () => proposalJson({ title: '水草的搬家请求' }),
      reproposal: () => proposalJson({
        title: '新来的求助',
        mechanism_summary: { pressure: '陌生求助', dilemma: '管 vs 不管', cost: '时间' }
      }),
      settlement: () => ({
        narrative: '它答应了代班。巡逻班次翻倍，鳍都游僵了，螃蟹挥挥钳子消失在夜色里。',
        facts: [
          { kind: 'relationship', content: '螃蟹记住了它的仗义' },
          { kind: 'consequence', content: '它欠下了一整晚的睡眠' }
        ],
        mechanism_card: {
          pressure: '巡逻队的代班请求', dilemma: '接不接别人的担子',
          choice_cost: '一整晚睡眠', lasting_consequence: '螃蟹把它当成可依赖的伙伴'
        },
        next_trigger: '螃蟹会介绍更多水友来找它'
      }),
      signal: () => ({ text: '螃蟹想让我代一晚班，我有点犹豫。你可以告诉我今天该硬气一点吗？' }),
      letter: () => ({ title: '第一夜', text: '入水第三天，我替螃蟹值了一晚班。鳍到现在还是僵的，但小贝壳上多了第一笔记录。' })
    },
    jev: { decide: over.decide || 'a1', contact: over.contact || ['continue', 'continue', 'final_letter'] }
  });
}

function release(w, feeling = '最近任务太多，谁找我帮忙都答应') {
  const r = w.orchestrator.startJourney({ ownerKey: 'o1', species: 'koi', water: 'xihu', feeling, tone: 'balanced' });
  assert.ok(r.ok, 'startJourney should ok');
  return r;
}

test('开局：preparing 立即可见；后台任务完成后 active + goal + 首遭遇提案', async () => {
  const world = makeWorld();
  const r = release(world);
  assert.equal(r.journey.status, 'preparing');
  assert.equal(world.orchestrator.getJourneyView({ ownerKey: 'o1', journeyId: r.journey.id }).goal, null, 'receipt not blocked by model');

  await world.drain(50, { stopWhen: () => !!world.db.getLatestEncounter(r.journey.id) });
  const j = world.db.getJourney(r.journey.id);
  assert.equal(j.status, 'active');
  assert.ok(j.goal.includes('小贝壳'));
  const enc = world.db.getLatestEncounter(r.journey.id);
  assert.equal(enc.status, 'proposed');
  assert.equal(enc.seq, 1);
  const m = world.db.getMotivation(r.journey.id);
  assert.equal(m.status, 'recognized');
  assert.equal(m.items.filter(i => i.usable)[0].evidenceText, '最近任务太多，谁找我帮忙都答应');
});

test('行动与事实：JEV 实际选择落库（source=jev）；结算不改写行动；下一遭遇承接旧事实', async () => {
  const world = makeWorld();
  const r = release(world);
  await world.drain(60, { stopWhen: () => !!world.db.getLatestEncounter(r.journey.id) });
  const e1Id = world.db.getLatestEncounter(r.journey.id).id;
  await world.drain(60, { stopWhen: () => world.db.getEncounter(e1Id).status === 'resolved' });
  const enc = world.db.getEncounter(e1Id);
  // 第一个事件：JEV 决策 + 结算完成
  // 等下一次提案发生（承接断言需要）
  assert.equal(enc.status, 'resolved');
  assert.equal(enc.chosenAction, 'a1');
  assert.equal(enc.decisionSource, 'jev');
  const j = world.db.getJourney(r.journey.id);
  assert.ok(j.event_count >= 1);
  assert.equal(j.state_version, j.event_count + 1, 'state version tracks commits');
  const facts = world.db.getFacts(r.journey.id);
  assert.ok(facts.some(f => f.content.includes('螃蟹记住了它')));
  // 后果不改变该动作：outcome 必须对应 a1（答应代班）
  assert.ok(enc.outcome.narrative.includes('答应') || enc.outcome.narrative.includes('代班'));
  // 下一遭遇承接旧事实（第一个提案必须携带已提交事实与机制卡）
  await world.drain(60, { stopWhen: () => world.llmState.calls.some(c => c.kind === 'proposal') });
  const proposalCall = world.llmState.calls.filter(c => c.kind === 'proposal')[0];
  assert.ok(proposalCall, 'proposal called');
  assert.ok(proposalCall.user.includes('螃蟹记住了它的仗义'), 'proposal must carry committed facts');
  assert.ok(proposalCall.user.includes('螃蟹把它当成可依赖的伙伴'), 'proposal must carry mechanism card');
});

test('幂等：decide/settle 任务重复执行不产生双决策/双事实', async () => {
  const world = makeWorld();
  const r = release(world);
  await world.drain(60, { stopWhen: () => !!world.db.getLatestEncounter(r.journey.id) });
  await world.drain(60, { stopWhen: () => world.db.getLatestEncounter(r.journey.id).status === 'resolved' });
  const before = world.db.getLatestEncounter(r.journey.id);
  const metaBefore = before.decisionMetaJson;
  const countBefore = world.db.getJourney(r.journey.id).event_count;
  // 重复投递同一 decide
  world.db.insertTask({ id: 'TASK-manual-decide', journeyId: r.journey.id, kind: 'decide', dueAt: 0, payload: { encounterId: before.id }, now: world.now() });
  const res = await world.orchestrator.runTask(world.db.getTask('TASK-manual-decide'), { now: world.now() });
  assert.equal(res.status, 'done');
  const after = world.db.getEncounter(before.id);
  assert.equal(after.decisionMetaJson, metaBefore, 'decision not overwritten');
  assert.equal(world.db.getJourney(r.journey.id).event_count, countBefore, 'no double commit');
});

test('提案失败不抹掉前一件已提交事实；重试后继续', async () => {
  const world = makeWorld();
  const r = release(world);
  let failOnce = true;
  const ai = require('../server/ai');
  const prev = ai.chatCompletion;
  ai.chatCompletion = async (messages, opts) => {
    const system = messages[0]?.content || '';
    if (system.includes('下一次具体遭遇') && failOnce) {
      failOnce = false;
      throw new Error('proposal boom');
    }
    return prev(messages, opts);
  };
  await world.drain(60, { stopWhen: () => world.llmState.calls.filter(c => c.kind === 'proposal').length >= 1 && world.db.getLatestEncounter(r.journey.id)?.seq === 2 });
  const j = world.db.getJourney(r.journey.id);
  assert.ok(j.event_count >= 1, 'first event intact');
  const facts = world.db.getFacts(r.journey.id);
  assert.ok(facts.some(f => f.content.includes('螃蟹记住了它')), 'first event facts survive proposal failure');
  const enc = world.db.getLatestEncounter(r.journey.id);
  assert.equal(enc.seq, 2, 'journey advanced after retry');
});

test('none_fit：先定向重提案一次；再 none_fit 则程序如实搁下（不伪装行动）', async () => {
  const world = makeWorld({
    tag: 'core-nonefit',
    decide: () => 'none_fit',
    contact: 'continue'
  });
  const r = world.orchestrator.startJourney({ ownerKey: 'o1', species: 'turtle', water: 'baikal', feeling: '不知道该不该继续', tone: 'balanced' });
  await world.drain(60, { stopWhen: () => !!world.db.getLatestEncounter(r.journey.id) });
  const e1Id = world.db.getLatestEncounter(r.journey.id).id;
  await world.drain(60, { stopWhen: () => { const e = world.db.getEncounter(e1Id); return e.status === 'resolved' && e.outcomeStatus === 'none_fit_closed'; } });
  const enc = world.db.getEncounter(e1Id);
  assert.equal(enc.status, 'resolved');
  assert.equal(enc.outcomeStatus, 'none_fit_closed');
  assert.equal(enc.chosenAction, 'none_fit');
  assert.ok(enc.reproposals >= 1, 'reproposal happened');
  assert.ok(!['a1', 'a2', 'a3'].includes(enc.chosenAction), 'no fake action');
  const facts = world.db.getFacts(r.journey.id);
  assert.ok(facts.some(f => f.content.includes('搁下')));
});

test('持续动机：JEV 决策输入始终携带动机档案与原话证据', async () => {
  const world = makeWorld();
  const r = release(world, '任务多到喘不过气，还总被临时塞活');
  await world.drain(60, { stopWhen: () => world.llmState.calls.some(c => c.kind === 'proposal') });
  const decideCalls = world.jevState.calls.filter(c => c.q.includes('action'));
  assert.ok(decideCalls.length >= 1);
  for (const c of decideCalls) {
    assert.ok(c.state.includes('本程动机档案'), 'decide must carry motivation');
    assert.ok(c.state.includes('任务多到喘不过气'), 'decide must carry raw evidence');
  }
});

test('版本冲突：并发结算只成功一次（第二次条件更新失败不覆盖）', async () => {
  const world = makeWorld();
  const r = release(world);
  await world.drain(60, { stopWhen: () => !!world.db.getLatestEncounter(r.journey.id) });
  const e1Id = world.db.getLatestEncounter(r.journey.id).id;
  await world.drain(60, { stopWhen: () => world.db.getEncounter(e1Id).status === 'resolved' });
  const j = world.db.getJourney(r.journey.id);
  const countBefore = j.event_count;
  const enc = world.db.getEncounter(e1Id);
  world.db.insertTask({ id: 'TASK-settle-again', journeyId: r.journey.id, kind: 'settle', dueAt: 0, payload: { encounterId: enc.id }, now: world.now() });
  const res = await world.orchestrator.runTask(world.db.getTask('TASK-settle-again'), { now: world.now() });
  assert.equal(res.status, 'done');
  assert.equal(world.db.getJourney(r.journey.id).event_count, countBefore, 'no double commit');
});
