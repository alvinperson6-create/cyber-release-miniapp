// 联系与寿命测试：信号（按时补给/超时/迟到）→ 非终局来信 → 继续行动 → 收束 → 用户结束 → 语气 → 静默护栏
const { test } = require('node:test');
const assert = require('node:assert');
const { createWorld, proposalJson } = require('./helpers/world');

function makeWorld(over = {}) {
  return createWorld({
    tag: over.tag || 'contact',
    llm: {
      opening: () => ({ goal: '学会量力而行地帮忙', encounter: proposalJson({ title: '螃蟹的代班请求' }) }),
      proposal: () => proposalJson({
        title: '湖长的联欢会',
        mechanism_summary: { pressure: '湖长的组织委托', dilemma: '接 vs 推', cost: '周末时间' }
      }),
      settlement: () => ({
        narrative: '它答应了代班，累但被需要，班次翻倍。',
        facts: [{ kind: 'relationship', content: '螃蟹成了它的朋友' }, { kind: 'consequence', content: '它一夜没睡' }],
        mechanism_card: { pressure: '代班请求', dilemma: '接不接', choice_cost: '睡眠', lasting_consequence: '成了朋友圈里最好说话的那个' },
        next_trigger: '更多请求会来'
      }),
      signal: () => ({ text: '螃蟹想让我代一晚班。我有点犹豫——你觉得这次可以答应吗？' }),
      letter: (ctx) => ctx && ctx.system.includes('最后一封')
        ? { title: '道别', text: '这程到此为止。我的小贝壳记满了，谢谢你那句“可以答应”。' }
        : { title: '第一夜', text: '我替螃蟹值了一晚班，鳍都是僵的。你说可以答应，我就答应了。' }
    },
    jev: { decide: over.decide || ['send_signal', 'a1', 'a1'], contact: over.contact || ['continue', 'letter', 'final_letter'], urgency: over.urgency }
  });
}

function view(w, jid, owner = 'o1') {
  return w.orchestrator.getJourneyView({ ownerKey: owner, journeyId: jid });
}

test('完整联系链：信号 → 按时补给 → JEV 行动 → 阶段来信 → 继续 → 收束来信（is_final）→ 自然结束', async () => {
  const world = makeWorld();
  const r = world.orchestrator.startJourney({ ownerKey: 'o1', species: 'koi', water: 'xihu', feeling: '谁找我帮忙都答应，最后只有我的事没做完', tone: 'balanced' });
  // 推进到信号寄出且未被处理时停下
  await world.drain(50, { stopWhen: () => { const v = view(world, r.journey.id); return !!(v.pendingSignal && !v.pendingSignal.replied); } });
  let v = view(world, r.journey.id);
  assert.equal(v.phase, 'awaiting_reply');
  assert.ok(v.pendingSignal, 'signal visible');
  assert.ok(v.pendingSignal.text.includes('螃蟹'));
  assert.ok(v.pendingSignal.dueAt > world.now());
  assert.ok(!v.pendingSignal.text.includes('后来'), 'signal must not spoil outcome');

  // 按时补给
  const rr = world.orchestrator.replyToSignal({ ownerKey: 'o1', journeyId: r.journey.id, text: '这次可以答应，但要记得睡觉' });
  assert.ok(rr.ok && rr.ontime);
  v = view(world, r.journey.id);
  assert.equal(v.pendingSignal.replied, true);

  // 补给立即唤醒决策
  await world.scheduler.tick({ budget: 3 });
  // 决策输入包含补给原文（证据而非命令）
  const decideCall = world.jevState.calls.filter(c => c.q.includes('action')).pop();
  assert.ok(decideCall.state.includes('这次可以答应，但要记得睡觉'));
  assert.ok(decideCall.state.includes('不是命令'));

  await world.drain(60);
  // 最小发送间隔/安静时段可能把最后一封排在数小时后投递：推进时钟直到全部投递
  for (let i = 0; i < 12; i++) {
    world.step(3600e3);
    if (!world.db.getMessages(r.journey.id).some(m => m.sentAt > world.now())) break;
  }
  v = view(world, r.journey.id);
  const kinds = v.messages.map(m => m.kind);
  assert.ok(kinds.includes('signal'), 'signal in mailbox');
  assert.ok(kinds.includes('user_reply'), 'user reply in mailbox');
  assert.ok(kinds.includes('letter'), 'stage letter in mailbox');
  assert.ok(kinds.includes('final_letter'), 'final letter in mailbox');
  const final = v.messages.find(m => m.kind === 'final_letter');
  assert.equal(final.meta.isFinal, true);
  const stage = v.messages.find(m => m.kind === 'letter');
  assert.ok(stage.text.length > 0);
  const j = world.db.getJourney(r.journey.id);
  assert.equal(j.status, 'ended_natural');
  assert.equal(j.ending_reason, 'natural');
  assert.equal(v.phase, 'ended');
  assert.equal(world.db.countOpenTasks(r.journey.id), 0);
  // 本程结束后留言不带入下程
  const late = world.orchestrator.replyToSignal({ ownerKey: 'o1', journeyId: r.journey.id, text: '再补一句' });
  assert.equal(late.ok, false);
  assert.equal(late.code, 'journey_ended');
});

test('同一生物再出发：同一 creature_id、新 journey_id、新动机版本', async () => {
  const world = makeWorld();
  const r1 = world.orchestrator.startJourney({ ownerKey: 'o1', species: 'koi', water: 'xihu', feeling: '第一程的烦恼', tone: 'balanced' });
  await world.drain(20, { stopWhen: () => view(world, r1.journey.id).phase !== 'preparing' });
  world.orchestrator.endJourney({ ownerKey: 'o1', journeyId: r1.journey.id });
  const r2 = world.orchestrator.startJourney({ ownerKey: 'o1', species: 'koi', water: 'baikal', feeling: '第二程完全不同的新烦恼：失眠', tone: 'absurd', creatureId: r1.creature.id });
  assert.ok(r2.ok);
  assert.equal(r2.creature.id, r1.creature.id);
  assert.notEqual(r2.journey.id, r1.journey.id);
  const m2 = world.db.getMotivation(r2.journey.id);
  assert.equal(m2.rawText, '第二程完全不同的新烦恼：失眠');
  assert.equal(m2.version, 1);
  const creatures = world.orchestrator.listCreatures('o1');
  assert.equal(creatures[0].journeyCount, 2);
  assert.equal(creatures[0].hasActiveJourney, true);
});

test('不回复不阻塞：到期后 JEV 在原候选中继续决策；迟到回复只作未来参考', async () => {
  const world = makeWorld({ decide: ['send_signal', 'a2', 'a2'], contact: 'continue' });
  const r = world.orchestrator.startJourney({ ownerKey: 'o1', species: 'turtle', water: 'baikal', feeling: '太慢了', tone: 'balanced' });
  await world.drain(50, { stopWhen: () => { const v = view(world, r.journey.id); return !!(v.pendingSignal && !v.pendingSignal.replied); } });
  const v0 = view(world, r.journey.id);
  const dueAt = v0.pendingSignal.dueAt;
  // 什么都不做，跨过截止；等这件遭遇被到期唤醒并决策
  world.setTime(dueAt + 1000);
  const encId0 = world.db.getLatestEncounter(r.journey.id).id;
  await world.drain(60, { stopWhen: () => world.db.getEncounter(encId0).status === 'decided' });
  const enc = world.db.getEncounter(encId0);
  assert.equal(enc.status, 'decided');
  assert.equal(enc.chosenAction, 'a2');
  assert.equal(enc.decisionSource, 'jev');
  const sig = world.db.getMessage(enc.signalMessageId);
  assert.equal(sig.status, 'expired', 'signal honestly marked expired');
  // 迟到回复：不改写已发生的选择
  const late = world.orchestrator.replyToSignal({ ownerKey: 'o1', journeyId: r.journey.id, text: '抱歉才看到' });
  assert.ok(late.ok && !late.ontime);
  const enc2 = world.db.getEncounter(enc.id);
  assert.equal(enc2.chosenAction, 'a2', 'late reply must not rewrite decision');
  const lateMsg = world.db.getMessages(r.journey.id).find(m => m.kind === 'user_reply' && m.meta?.late);
  assert.ok(lateMsg, 'late reply recorded as reference');
});

test('用户主动结束：立即生效，不等模型；后台不再生成事件', async () => {
  const world = makeWorld();
  const r = world.orchestrator.startJourney({ ownerKey: 'o1', species: 'koi', water: 'xihu', feeling: '好累', tone: 'gentle' });
  await world.drain(50, { stopWhen: () => { const v = view(world, r.journey.id); return !!(v.pendingSignal && !v.pendingSignal.replied); } });
  const callsBefore = world.db.getModelCalls(r.journey.id).length;
  const end = world.orchestrator.endJourney({ ownerKey: 'o1', journeyId: r.journey.id });
  assert.ok(end.ok);
  const j = world.db.getJourney(r.journey.id);
  assert.equal(j.status, 'ended_user');
  assert.equal(world.db.countOpenTasks(r.journey.id), 0);
  const msgsBefore = world.db.getMessages(r.journey.id).length;
  await world.drain(10);
  assert.equal(world.db.getMessages(r.journey.id).length, msgsBefore, 'no new messages after end');
  assert.equal(world.db.getModelCalls(r.journey.id).length, callsBefore, 'no model calls after end');
  assert.equal(world.orchestrator.endJourney({ ownerKey: 'o1', journeyId: r.journey.id }).code, 'already_ended');
});

test('语气偏好：只改未来提案的荒诞基调，不动已提交事实与旧消息', async () => {
  const world = makeWorld({ decide: ['a1', 'a1'], contact: 'continue' });
  const r = world.orchestrator.startJourney({ ownerKey: 'o1', species: 'koi', water: 'xihu', feeling: '烦', tone: 'balanced' });
  // 推进到第一次“下一遭遇提案”发生即停
  await world.drain(50, { stopWhen: () => world.llmState.calls.some(c => c.kind === 'proposal') });
  const msgsBefore = world.db.getMessages(r.journey.id).map(m => m.id);
  const factsBefore = world.db.getFacts(r.journey.id).map(f => f.id);
  const rr = world.orchestrator.setTone({ ownerKey: 'o1', journeyId: r.journey.id, tone: 'absurd' });
  assert.ok(rr.ok);
  assert.equal(world.db.getJourney(r.journey.id).tone, 'absurd');
  // 等到第二次提案
  await world.drain(60, { stopWhen: () => world.llmState.calls.filter(c => c.kind === 'proposal').length >= 2 });
  const proposalCalls = world.llmState.calls.filter(c => c.kind === 'proposal');
  assert.ok(proposalCalls.length >= 2);
  assert.ok(proposalCalls[1].system.includes('更荒唐') || proposalCalls[1].system.includes('更大胆'), 'future proposals use new tone');
  assert.equal(proposalCalls[0].system.includes('更荒唐'), false, 'earlier proposal used old tone');
  const msgsAfter = world.db.getMessages(r.journey.id).map(m => m.id);
  const factsAfter = world.db.getFacts(r.journey.id).map(f => f.id);
  assert.deepEqual(msgsAfter.slice(0, msgsBefore.length), msgsBefore, 'committed messages untouched');
  assert.deepEqual(factsAfter.slice(0, factsBefore.length), factsBefore, 'committed facts append-only, never rewritten');
  assert.equal(world.orchestrator.setTone({ ownerKey: 'o1', journeyId: r.journey.id, tone: 'spicy' }).code, 'invalid_tone');
});

test('最大静默护栏：长时间无联系触发检查点并产生来信', async () => {
  process.env.J_MAX_EVENTS = '100';
  const world = makeWorld({ decide: ['a1', 'a1'], contact: 'letter' });
  const r = world.orchestrator.startJourney({ ownerKey: 'o1', species: 'cloud', water: 'ness', feeling: '乱糟糟', tone: 'balanced' });
  await world.drain(30);
  const v = view(world, r.journey.id);
  assert.equal(v.pendingSignal, null, 'no signal pending (decided directly)');
  // 清空在途联系类任务，并把时钟推到最后一封既定投递之后 + 37h，保证护栏可触发
  for (let i = 0; i < 20; i++) {
    if (!world.db.hasOpenTask(r.journey.id, 'letter') && !world.db.hasOpenTask(r.journey.id, 'final_letter') && !world.db.hasOpenTask(r.journey.id, 'contact')) break;
    await world.drain(10);
  }
  const sentTimes = world.db.getMessages(r.journey.id).map(m => m.sentAt);
  const lastScheduled = sentTimes.length ? Math.max(...sentTimes) : world.now();
  world.setTime(Math.max(world.now(), lastScheduled) + 37 * 3600e3);
  await world.scheduler.tick({ budget: 3 });
  assert.ok(world.db.hasOpenTask(r.journey.id, 'contact'), 'silence guard schedules contact');
  await world.drain(20);
  const msgs = world.db.getMessages(r.journey.id);
  assert.ok(msgs.some(m => m.kind === 'letter'), 'silence guard led to letter');
  delete process.env.J_MAX_EVENTS;
});

test('安静时段：深夜生成的信顺延到早晨投递（投递前视图不可见）', async () => {
  const world = makeWorld({ decide: ['a1', 'a1'], contact: 'letter' });
  const lateNight = new Date(); lateNight.setHours(23, 30, 0, 0);
  world.setTime(lateNight.getTime());
  const r = world.orchestrator.startJourney({ ownerKey: 'o1', species: 'koi', water: 'xihu', feeling: '夜宵', tone: 'balanced' });
  await world.drain(40);
  const msgs = world.db.getMessages(r.journey.id);
  const letter = msgs.find(m => m.kind === 'letter' || m.kind === 'final_letter');
  assert.ok(letter, 'letter written');
  const h = new Date(letter.sentAt).getHours();
  assert.ok(h >= 7, `letter delivered after quiet hours (got hour=${h})`);
  // 回到投递前：视图不可见
  world.setTime(letter.sentAt - 60000);
  const v = world.orchestrator.getJourneyView({ ownerKey: 'o1', journeyId: r.journey.id });
  assert.ok(!v.messages.some(m => m.id === letter.id), 'not visible before delivery time');
});


test('信号截止由 JEV 紧急度决定（1-120 分钟分桶）；无效答案回退默认并如实记录来源', async () => {
  // 分桶边界：所有映射都在 1-120 分钟
  const { SIGNAL_URGENCY_MINUTES } = require('../server/orchestrator');
  for (const mins of Object.values(SIGNAL_URGENCY_MINUTES)) {
    assert.ok(mins >= 1 && mins <= 120, `分钟数 ${mins} 超出 1-120`);
  }

  // urgent → 10 分钟，元数据如实记录
  const w1 = makeWorld({ tag: 'urg1', urgency: 'urgent', contact: 'continue' });
  const r1 = w1.orchestrator.startJourney({ ownerKey: 'o1', species: 'koi', water: 'xihu', feeling: '谁找我帮忙都答应', tone: 'balanced' });
  await w1.drain(50, { stopWhen: () => { const v = view(w1, r1.journey.id); return !!(v.pendingSignal && !v.pendingSignal.replied); } });
  const enc1 = w1.db.getLatestEncounter(r1.journey.id);
  const msg1 = w1.db.getMessage(enc1.signalMessageId);
  assert.equal(enc1.signalDueAt - msg1.sentAt, 10 * 60e3, 'urgent 桶 = 10 分钟');
  assert.equal(msg1.meta.deadlineSource, 'jev_urgency');
  assert.equal(msg1.meta.urgencyLevel, 'urgent');
  assert.equal(msg1.meta.urgencyMinutes, 10);

  // 无效桶 → 回退默认 6h，来源如实
  const w2 = makeWorld({ tag: 'urg2', urgency: 'bogus-level', contact: 'continue' });
  const r2 = w2.orchestrator.startJourney({ ownerKey: 'o1', species: 'turtle', water: 'baikal', feeling: '太慢', tone: 'balanced' });
  await w2.drain(50, { stopWhen: () => { const v = view(w2, r2.journey.id); return !!(v.pendingSignal && !v.pendingSignal.replied); } });
  const enc2 = w2.db.getLatestEncounter(r2.journey.id);
  const msg2 = w2.db.getMessage(enc2.signalMessageId);
  assert.equal(enc2.signalDueAt - msg2.sentAt, 6 * 3600e3, '无效答案回退默认 6h');
  assert.equal(msg2.meta.deadlineSource, 'fallback_default');
  assert.equal(msg2.meta.urgencyLevel, null);

  // patient → 120 分钟（区间上界）
  const w3 = makeWorld({ tag: 'urg3', urgency: 'patient', contact: 'continue' });
  const r3 = w3.orchestrator.startJourney({ ownerKey: 'o1', species: 'cloud', water: 'ness', feeling: '乱糟糟', tone: 'balanced' });
  await w3.drain(50, { stopWhen: () => { const v = view(w3, r3.journey.id); return !!(v.pendingSignal && !v.pendingSignal.replied); } });
  const enc3 = w3.db.getLatestEncounter(r3.journey.id);
  assert.equal(enc3.signalDueAt - w3.db.getMessage(enc3.signalMessageId).sentAt, 120 * 60e3, 'patient 桶 = 120 分钟');
});
