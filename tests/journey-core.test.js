// 旅程核心：preparing → 开局 → 决策 → 结算 → 阶段信/收束
//
// 断言的是**业务后果**，不是实现细节：状态迁移、事实落账、任务排程、
// 模型调用次数，以及"重复读取不改变任何事实"。

const { test } = require('node:test');
const assert = require('node:assert');
const { createWorld, baseScripts, baseHandlers } = require('./helpers/world');
const { MODEL_OP } = require('../shared/contracts/enums');

function world(tag, over = {}) {
  return createWorld({
    tag,
    scripts: baseScripts(over.scripts),
    handlers: baseHandlers(over.handlers),
    ...over.opts
  });
}

test('preparing → 开局：命令先给回执，后台编排后才有目标；重复 GET 不改变事实与调用数', async () => {
  const w = world('core-opening');
  try {
    const r = w.commands.release.execute({
      ownerKey: 'A', input: { species: 'koi', water: 'xihu', feeling: '明天要答辩，紧张到胃疼', tone: 'balanced' }
    });
    assert.ok(r.ok);
    assert.equal(r.status, 'preparing', '命令立即返回 preparing，不等模型');

    // 目标在开局前不可见
    const before = w.queries.getJourneyView({ ownerKey: 'A', journeyId: r.journeyId });
    assert.equal(before.phase, 'preparing');
    assert.equal(before.goal, null);

    await w.drain(6);

    const after = w.queries.getJourneyView({ ownerKey: 'A', journeyId: r.journeyId });
    assert.equal(after.status, 'active');
    assert.ok(after.goal, '开局后才有目标');

    // 重复 GET 不改变事实、任务与模型调用数
    const factsBefore = after.factsCount;
    const callsBefore = w.store.countModelCalls(r.journeyId);
    const tasksBefore = w.store.getDb().prepare('SELECT COUNT(*) c FROM tasks WHERE journey_id = ?').get(r.journeyId).c;
    for (let i = 0; i < 5; i++) w.queries.getJourneyView({ ownerKey: 'A', journeyId: r.journeyId });
    const again = w.queries.getJourneyView({ ownerKey: 'A', journeyId: r.journeyId });
    assert.equal(again.factsCount, factsBefore, '读取不产生事实');
    assert.equal(w.store.countModelCalls(r.journeyId), callsBefore, '读取不触发模型');
    assert.equal(
      w.store.getDb().prepare('SELECT COUNT(*) c FROM tasks WHERE journey_id = ?').get(r.journeyId).c,
      tasksBefore, '读取不排任务'
    );
  } finally { await w.close(); }
});

test('决策 → 结算：JEV 选择落账，事实与机制卡同事务写入', async () => {
  const w = world('core-settle');
  try {
    const r = w.commands.release.execute({ ownerKey: 'A', input: { species: 'koi', water: 'xihu', feeling: '烦' } });
    await w.drain(6);

    // 取首个遭遇（旅程会继续推进，latest 会往后走）
    const encounters = w.store.getEncounters(r.journeyId);
    const first = encounters[0];
    assert.ok(first, '应有遭遇');
    assert.equal(first.status, 'resolved', '首个遭遇已结算');
    assert.equal(first.chosenAction, 'a1', 'JEV 的选择被如实落账');
    assert.equal(first.decisionSource, 'jev');

    const facts = w.store.getFacts(r.journeyId);
    assert.ok(facts.length > 0, '结算事实已落账');
    const cards = w.store.getRecentCards(w.store.getJourney(r.journeyId).creature_id, 5);
    assert.ok(cards.length > 0, '机制卡已落账');

    const j = w.store.getJourney(r.journeyId);
    assert.ok(j.event_count >= 1, '事件计数推进');
    assert.ok(j.state_version > 0, '状态版本推进');

    // 遭遇 seq 唯一：不会插入两个同序遭遇
    const seqs = encounters.map(e => e.seq);
    assert.equal(new Set(seqs).size, seqs.length, 'seq 不重复');
  } finally { await w.close(); }
});

test('阶段信后继续旅程', async () => {
  const w = world('core-letter', {
    handlers: baseHandlers({
      // 结算一致性检查与联系检查点在同一次请求里，contact 答案来自这里
      [MODEL_OP.SETTLEMENT_CHECK]: () => ({
        action_consistency: { noul: 0.05 },
        contact: { choice: 'letter', probabilities: {}, confidence: 0.9 }
      })
    })
  });
  try {
    const r = w.commands.release.execute({ ownerKey: 'A', input: { species: 'koi', water: 'xihu', feeling: '烦' } });
    await w.drain(14);

    const msgs = w.store.getMessages(r.journeyId);
    const letter = msgs.find(m => m.kind === 'letter');
    assert.ok(letter, '应有阶段来信');
    assert.ok(letter.text.length >= 10, '来信有实质内容');
    assert.ok(letter.meta?.boundary, '来信如实记录边界检查来源');

    // 阶段信后旅程仍在进行，且排了下一步
    assert.equal(w.store.getJourney(r.journeyId).status, 'active');
    assert.ok(
      w.store.getDb().prepare(
        `SELECT COUNT(*) c FROM tasks WHERE journey_id = ? AND status IN ('pending','leased')`
      ).get(r.journeyId).c > 0,
      '阶段信后应继续排程'
    );
  } finally { await w.close(); }
});

test('自然收束：final_letter 落账后终态稳定，任务被取消', async () => {
  const w = world('core-final', {
    handlers: baseHandlers({
      [MODEL_OP.SETTLEMENT_CHECK]: () => ({
        action_consistency: { noul: 0.05 },
        contact: { choice: 'final_letter', probabilities: {}, confidence: 0.9 }
      })
    })
  });
  try {
    const r = w.commands.release.execute({ ownerKey: 'A', input: { species: 'koi', water: 'xihu', feeling: '烦' } });
    await w.drain(18);

    const j = w.store.getJourney(r.journeyId);
    assert.equal(j.status, 'ended_natural', '自然收束进入终态');
    assert.equal(j.ending_reason, 'natural');

    const msgs = w.store.getMessages(r.journeyId);
    assert.ok(msgs.some(m => m.kind === 'final_letter'), '应有收束来信');

    const openTasks = w.store.getDb().prepare(
      `SELECT COUNT(*) c FROM tasks WHERE journey_id = ? AND status IN ('pending','leased')`
    ).get(r.journeyId).c;
    assert.equal(openTasks, 0, '终态后不再有开放任务');
  } finally { await w.close(); }
});

test('用户结束立即生效；再次结束按契约返回 already_ended', async () => {
  const w = world('core-end');
  try {
    const r = w.commands.release.execute({ ownerKey: 'A', input: { species: 'koi', water: 'xihu', feeling: '烦' } });
    const first = w.commands.endJourney.execute({ ownerKey: 'A', journeyId: r.journeyId, input: {} });
    assert.ok(first.ok);
    assert.equal(first.status, 'ended_user');

    const second = w.commands.endJourney.execute({ ownerKey: 'A', journeyId: r.journeyId, input: {} });
    assert.equal(second.ok, false);
    assert.equal(second.code, 'already_ended');
  } finally { await w.close(); }
});

test('语气只影响未来：改语气不改动已提交事实与已有来信', async () => {
  const w = world('core-tone');
  try {
    const r = w.commands.release.execute({ ownerKey: 'A', input: { species: 'koi', water: 'xihu', feeling: '烦' } });
    await w.drain(6);
    const factsBefore = w.store.getFacts(r.journeyId).map(f => f.content);
    const msgsBefore = w.store.getMessages(r.journeyId).map(m => m.text);

    const t = w.commands.setTone.execute({ ownerKey: 'A', journeyId: r.journeyId, input: { tone: 'absurd' } });
    assert.ok(t.ok);
    assert.equal(w.store.getJourney(r.journeyId).tone, 'absurd');

    assert.deepEqual(w.store.getFacts(r.journeyId).map(f => f.content), factsBefore, '事实不变');
    assert.deepEqual(w.store.getMessages(r.journeyId).map(m => m.text), msgsBefore, '已有来信不变');
  } finally { await w.close(); }
});

test('JEV 不可用：决策重试后暂停，绝不产生规则回退的伪 JEV 行动', async () => {
  const w = world('core-nojev');
  try {
    w.jev.setEnabled(false);
    const r = w.commands.release.execute({ ownerKey: 'A', input: { species: 'koi', water: 'xihu', feeling: '烦' } });
    for (let i = 0; i < 12; i++) {
      w.step(10 * 60e3);
      await w.scheduler.tick({ budget: 3 });
    }
    const enc = w.store.getLatestEncounter(r.journeyId);
    assert.ok(enc);
    assert.equal(enc.status, 'proposed', '没有 JEV 就没有决策落账');
    const j = w.store.getJourney(r.journeyId);
    assert.equal(j.status, 'paused');
    const decided = w.store.getDb().prepare(
      `SELECT COUNT(*) c FROM encounters WHERE journey_id = ? AND decision_source IS NOT NULL`
    ).get(r.journeyId).c;
    assert.equal(decided, 0, '不得有伪造的决策来源');
  } finally { await w.close(); }
});

test('读取接口不推进状态：多次 GET 后事实与遭遇状态不变', async () => {
  const w = world('core-readonly');
  try {
    const r = w.commands.release.execute({ ownerKey: 'A', input: { species: 'koi', water: 'xihu', feeling: '烦' } });
    await w.drain(6);
    const snap = w.store.getJourney(r.journeyId);
    const encSnap = w.store.getLatestEncounter(r.journeyId);
    for (let i = 0; i < 10; i++) {
      w.queries.getJourneyView({ ownerKey: 'A', journeyId: r.journeyId });
      w.queries.listJourneys('A');
      w.queries.listCreatures('A');
    }
    assert.equal(w.store.getJourney(r.journeyId).state_version, snap.state_version);
    assert.equal(w.store.getLatestEncounter(r.journeyId).status, encSnap.status);
  } finally { await w.close(); }
});

test('同一生物再次出发：新旅程独立，旅程计数为 2', async () => {
  const w = world('core-relaunch');
  try {
    const r1 = w.commands.release.execute({ ownerKey: 'A', input: { species: 'koi', water: 'xihu', feeling: '第一个烦恼' } });
    await w.drain(6);
    const creatureId = r1.creatureId;

    const r2 = w.commands.release.execute({
      ownerKey: 'A', input: { species: 'koi', water: 'baikal', feeling: '第二个烦恼', creatureId }
    });
    assert.ok(r2.ok);
    assert.equal(r2.creatureId, creatureId, '复用同一生物');
    assert.notEqual(r2.journeyId, r1.journeyId);

    await w.drain(8);
    const c = w.queries.listCreatures('A').find(x => x.id === creatureId);
    assert.equal(c.journeyCount, 2);
  } finally { await w.close(); }
});
