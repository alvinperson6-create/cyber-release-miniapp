// 竞态与护栏：结束、补给、租约、幂等、defer/retry
//
// 这一组是阶段 C/D 的核心验收：每一条都对应 handoff §5 表格里的具体行。

const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { createWorld, baseScripts, baseHandlers, createFixtureModel } = require('./helpers/world');
const { MODEL_OP, COMMIT_RESULT, SCHEDULER_RESULT } = require('../shared/contracts/enums');

function world(tag, over = {}) {
  return createWorld({
    tag,
    scripts: baseScripts(over.scripts),
    handlers: baseHandlers(over.handlers),
    ...over.opts
  });
}

function startSignalJourney(w, ownerKey = 'A') {
  // 让 JEV 选择寄信号，从而进入"待回应"状态
  w.jev.setEnabled(true);
  const r = w.commands.release.execute({ ownerKey, input: { species: 'koi', water: 'xihu', feeling: '烦' } });
  return r;
}

// ======== 幂等 ========

test('建程幂等：同 owner 同键同输入只落一次；同键异输入冲突', async () => {
  const w = world('idem-release');
  try {
    const input = { species: 'koi', water: 'xihu', feeling: '同一个烦恼', requestId: 'req-release-0001' };
    const first = w.commands.release.execute({ ownerKey: 'A', input });
    const second = w.commands.release.execute({ ownerKey: 'A', input });
    assert.ok(first.ok && second.ok);
    assert.equal(second.journeyId, first.journeyId, '重放返回同一旅程');
    assert.equal(second.replayed, true);

    const count = w.store.getDb().prepare('SELECT COUNT(*) c FROM journeys').get().c;
    assert.equal(count, 1, '只创建一条旅程');

    // 同键异载荷 → 冲突
    const conflict = w.commands.release.execute({
      ownerKey: 'A',
      input: { species: 'turtle', water: 'xihu', feeling: '另一个烦恼', requestId: 'req-release-0001' }
    });
    assert.equal(conflict.ok, false);
    assert.equal(conflict.code, 'idempotency_conflict');
  } finally { await w.close(); }
});

test('幂等键按 owner 分域：不同 owner 的同键互不串用', async () => {
  const w = world('idem-owner');
  try {
    const a = w.commands.release.execute({
      ownerKey: 'A', input: { species: 'koi', water: 'xihu', feeling: 'A', requestId: 'req-shared-0001' }
    });
    const b = w.commands.release.execute({
      ownerKey: 'B', input: { species: 'koi', water: 'xihu', feeling: 'B', requestId: 'req-shared-0001' }
    });
    assert.ok(a.ok && b.ok);
    assert.notEqual(a.journeyId, b.journeyId, '不同 owner 各自建程');
    assert.notEqual(a.replayed, true);
    assert.notEqual(b.replayed, true);
  } finally { await w.close(); }
});

test('结束幂等：重试只产生一条结束提示', async () => {
  const w = world('idem-end');
  try {
    const r = w.commands.release.execute({ ownerKey: 'A', input: { species: 'koi', water: 'xihu', feeling: '烦' } });
    const input = { requestId: 'req-end-000001' };
    const first = w.commands.endJourney.execute({ ownerKey: 'A', journeyId: r.journeyId, input });
    const second = w.commands.endJourney.execute({ ownerKey: 'A', journeyId: r.journeyId, input });
    assert.ok(first.ok);
    assert.ok(second.ok);
    assert.equal(second.replayed, true);

    const sysMsgs = w.store.getMessages(r.journeyId).filter(m => m.kind === 'system');
    assert.equal(sysMsgs.length, 1, '只写一条结束提示');
  } finally { await w.close(); }
});

// ======== 回复目标 ========

test('回复必须显式给目标：缺少 signalMessageId/encounterId 直接拒绝', async () => {
  const w = world('reply-target-required');
  try {
    const r = startSignalJourney(w);
    await w.drain(6);

    const noTarget = w.commands.replyToSignal.execute({
      ownerKey: 'A', journeyId: r.journeyId, input: { text: '随便说点什么' }
    });
    assert.equal(noTarget.ok, false);
    assert.equal(noTarget.code, 'missing_reply_target', '不得静默推断最新信号');

    const view = w.queries.getJourneyView({ ownerKey: 'A', journeyId: r.journeyId });
    // 本场景 JEV 直接行动，不寄信号，因此没有 pendingSignal
    assert.equal(view.pendingSignal, null);
  } finally { await w.close(); }
});

test('旧信号不能绑定新信号：过期的 signalMessageId 返回明确结果而不是绑定最新', async () => {
  const w = world('reply-stale-signal', {
    handlers: baseHandlers({
      [MODEL_OP.ACTION_DECISION]: ({ seq }) => ({
        // 第一次决策寄信号，之后直接行动
        action: { choice: seq === 0 ? 'send_signal' : 'a1', probabilities: {}, confidence: 0.9 },
        signal_urgency: { choice: 'patient', probabilities: {}, confidence: 0.9 }
      })
    })
  });
  try {
    const r = startSignalJourney(w);
    await w.drain(8);

    const encounters = w.store.getEncounters(r.journeyId);
    const withSignal = encounters.find(e => e.signalMessageId);
    assert.ok(withSignal, '应有寄出过信号的遭遇');
    const oldSignalId = withSignal.signalMessageId;

    // 让时间走过截止，让该信号过期
    w.step(4 * 60 * 60e3);
    await w.drain(8);

    // 用旧信号 ID 回复：目标可追溯，但已过期 → late 记录，不改原决定
    const encAfter = w.store.getEncounter(withSignal.id);
    if (encAfter.status === 'decided' || encAfter.status === 'resolved') {
      const lateReply = w.commands.replyToSignal.execute({
        ownerKey: 'A', journeyId: r.journeyId,
        input: { text: '这条来晚了', signalMessageId: oldSignalId }
      });
      assert.ok(lateReply.ok, '目标可追溯时接受为迟到参考');
      assert.equal(lateReply.ontime, false);
      assert.equal(lateReply.late, true);

      // 关键：不得改写已提交的决定
      assert.equal(w.store.getEncounter(withSignal.id).chosenAction, encAfter.chosenAction,
        '迟到回复不改写已提交行动');
      assert.equal(w.store.getEncounter(withSignal.id).supplyMessageId, encAfter.supplyMessageId,
        '迟到回复不占用补给位');
    }

    // 完全不存在的信号 → 明确拒绝
    const bogus = w.commands.replyToSignal.execute({
      ownerKey: 'A', journeyId: r.journeyId,
      input: { text: '给不存在信号的回复', signalMessageId: 'MSG-does-not-exist' }
    });
    assert.equal(bogus.ok, false);
    assert.equal(bogus.code, 'signal_not_found');
  } finally { await w.close(); }
});

test('按时补给进入对应遭遇的决策输入；迟到参考只进后续未决上下文', async () => {
  const w = world('reply-supply', {
    handlers: baseHandlers({
      [MODEL_OP.ACTION_DECISION]: ({ seq }) => ({
        action: { choice: seq === 0 ? 'send_signal' : 'a1', probabilities: {}, confidence: 0.9 },
        signal_urgency: { choice: 'patient', probabilities: {}, confidence: 0.9 }
      })
    })
  });
  try {
    const r = startSignalJourney(w);
    // 分步推进：先开局，再决策寄信号；每次只跑到当下到期
    await w.drain(2, { advanceClock: false });   // opening
    w.step(4 * 60e3);
    await w.drain(2, { advanceClock: false });   // decide → send_signal

    const enc = w.store.getEncounters(r.journeyId).find(e => e.signalMessageId);
    assert.ok(enc, '应有待回应信号');
    assert.ok(enc.signalDueAt > w.now(), '截止时间在未来');

    const reply = w.commands.replyToSignal.execute({
      ownerKey: 'A', journeyId: r.journeyId,
      input: { text: '你可以答应它', signalMessageId: enc.signalMessageId, requestId: 'req-reply-00001' }
    });
    assert.ok(reply.ok);
    assert.equal(reply.ontime, true, '截止前回复为按时');

    // 补给占用该遭遇的补给位
    const after = w.store.getEncounter(enc.id);
    assert.ok(after.supplyMessageId, '补给位已占用');
    assert.equal(after.supplyMessageId, reply.messageId);

    // 同一信号第二条回复 → 补给位已被占，按迟到参考
    const second = w.commands.replyToSignal.execute({
      ownerKey: 'A', journeyId: r.journeyId,
      input: { text: '再补一句', signalMessageId: enc.signalMessageId, requestId: 'req-reply-00002' }
    });
    assert.ok(second.ok);
    assert.equal(second.ontime, false, '第二条不是按时');
    assert.equal(w.store.getEncounter(enc.id).supplyMessageId, reply.messageId, '补给位不被抢占');

    // 继续决策：按时补给进入该遭遇的决策输入
    w.step(60e3);
    await w.drain(4, { advanceClock: false });
    const decisionCall = w.jevCalls.filter(c => c.op === MODEL_OP.ACTION_DECISION).pop();
    assert.ok(decisionCall, '应发生第二次决策');
    assert.ok(decisionCall.state.includes('你可以答应它'), '按时补给进入决策输入');
    assert.ok(decisionCall.state.includes('再补一句'), '迟到参考进入后续未决上下文');
    assert.ok(decisionCall.state.includes('来晚了'), '迟到参考被如实标注');

    // 已提交的决定没有被迟到回复改写
    assert.equal(w.store.getEncounter(enc.id).chosenAction, 'a1');
  } finally { await w.close(); }
});

test('本程已结束时回复被拒绝，留言不带进下一程', async () => {
  const w = world('reply-ended');
  try {
    const r = startSignalJourney(w);
    await w.drain(4);
    w.commands.endJourney.execute({ ownerKey: 'A', journeyId: r.journeyId, input: {} });

    const enc = w.store.getEncounters(r.journeyId).find(e => e.signalMessageId);
    const reply = w.commands.replyToSignal.execute({
      ownerKey: 'A', journeyId: r.journeyId,
      input: { text: '结束后还想说', signalMessageId: enc ? enc.signalMessageId : 'MSG-x' }
    });
    assert.equal(reply.ok, false);
    assert.equal(reply.code, 'journey_ended');
  } finally { await w.close(); }
});

// ======== 结束竞态 ========

test('模型调用期间用户结束：释放响应后不提交任何新事实，终态不复活', async () => {
  // 可暂停 adapter：调用开始 → 我们结束旅程 → 释放响应
  let release;
  const gate = new Promise(res => { release = res; });
  let startedResolve;
  const started = new Promise(res => { startedResolve = res; });

  const slowModel = createFixtureModel(baseScripts({
    [MODEL_OP.SETTLEMENT]: async () => {
      startedResolve();
      await gate;
      return {
        narrative: '事情有了结果，它继续往前游。',
        facts: [{ kind: 'consequence', content: '不应落账的后果' }],
        mechanism_card: { pressure: 'p', dilemma: 'd', choice_cost: 'c', lasting_consequence: 'l' }
      };
    }
  }), { label: 'slow' });

  const w = createWorld({
    tag: 'race-end',
    textModel: slowModel,
    handlers: baseHandlers()
  });
  try {
    const r = w.commands.release.execute({ ownerKey: 'A', input: { species: 'koi', water: 'xihu', feeling: '烦' } });
    await w.drain(4);

    // 决策已完成，进入结算；结算会卡在模型调用里
    const enc = w.store.getEncounters(r.journeyId)[0];
    assert.ok(enc);
    const factsBefore = w.store.getFacts(r.journeyId).length;

    const drainPromise = w.drain(6);
    await started;                       // 结算模型调用已发出

    // 用户在模型返回前结束旅程
    const end = w.commands.endJourney.execute({ ownerKey: 'A', journeyId: r.journeyId, input: {} });
    assert.ok(end.ok);
    const statusAtEnd = w.store.getJourney(r.journeyId).status;

    release();                            // 释放模型响应
    await drainPromise;
    await w.drain(6);

    // 断言：无新事实、终态未被改写、没有新增剧情信件
    assert.equal(w.store.getJourney(r.journeyId).status, statusAtEnd, '终态不被复活');
    assert.equal(w.store.getJourney(r.journeyId).status, 'ended_user');
    assert.equal(w.store.getFacts(r.journeyId).length, factsBefore, '在途模型结果不落账');

    const encAfter = w.store.getEncounter(enc.id);
    assert.equal(encAfter.status, 'decided', '遭遇不会被结算推进');
    assert.equal(encAfter.outcome, null, '不写入结算结果');

    // 但真实发生的调用仍然记账（用量不能因为取消而消失）
    const calls = w.store.getModelCalls(r.journeyId);
    assert.ok(calls.length > 0, '已发生的调用仍记账');
    assert.ok(calls.some(c => c.kind === MODEL_OP.SETTLEMENT), '被取消的那次结算调用有记录');
  } finally { await w.close(); }
});

test('旧 worker 与新租约：旧 worker 的迟到结果无法提交', async () => {
  const w = world('race-lease');
  try {
    const r = w.commands.release.execute({ ownerKey: 'A', input: { species: 'koi', water: 'xihu', feeling: '烦' } });

    // worker1 认领后"崩溃"（不收尾）
    const [claimed] = w.store.claimDueTasks(w.now(), { limit: 1, leaseMs: 1000 });
    assert.ok(claimed);
    const oldLease = claimed.lease_key;

    // 租约过期 → 回收 → worker2 接手并完成
    w.step(2000);
    w.store.recoverExpiredLeases(w.now());
    await w.drain(6);

    const t = w.store.getTask(claimed.id);
    assert.notEqual(t.lease_key, oldLease, '任务已被新持有者接管');

    // 旧 worker 迟到收尾：全部影响 0 行
    assert.equal(w.store.completeTask(claimed.id, w.now(), oldLease), false);
    assert.equal(w.store.rescheduleTask(claimed.id, w.now() + 1000, w.now(), oldLease), false);
    assert.equal(w.store.failTask(claimed.id, 'stale', w.now(), oldLease), false);

    // 业务 operation 至多落一次账
    const opId = `op-${r.journeyId}-1`;
    assert.equal(w.store.claimOperation({ operationId: opId, journeyId: r.journeyId, kind: 'letter', now: w.now() }), 'applied');
    assert.equal(w.store.claimOperation({ operationId: opId, journeyId: r.journeyId, kind: 'letter', now: w.now() }), 'already_applied');
  } finally { await w.close(); }
});

// ======== defer vs retry ========

test('正常等待不耗尽错误重试次数：信号未到期反复 defer 后仍能按期继续', async () => {
  const w = world('defer-wait', {
    handlers: baseHandlers({
      [MODEL_OP.ACTION_DECISION]: ({ seq }) => ({
        // 第一次寄信号；到期后必须真正决策，而不是再寄一次
        action: { choice: seq === 0 ? 'send_signal' : 'a1', probabilities: {}, confidence: 0.9 },
        signal_urgency: { choice: 'patient', probabilities: {}, confidence: 0.9 }
      })
    })
  });
  try {
    const r = startSignalJourney(w);
    await w.drain(2, { advanceClock: false });   // opening
    w.step(4 * 60e3);
    await w.drain(2, { advanceClock: false });   // decide → send_signal

    const enc = w.store.getEncounters(r.journeyId).find(e => e.signalMessageId);
    assert.ok(enc, '应寄出信号');
    const dueAt = enc.signalDueAt;
    assert.ok(dueAt > w.now(), '截止在未来');

    // 排一个"落在等待窗口内"的 decide 任务。
    // 这正是 reconcile 对 signal_sent 遭遇会排的形状：信号还开着、
    // 还没有补给 → 决策应当 defer 到截止，而不是失败重试。
    w.store.insertTask({
      id: w.store.rid('TASK'), journeyId: r.journeyId, kind: 'decide',
      dueAt: w.now(), payload: { encounterId: enc.id }, now: w.now()
    });
    const taskId = w.store.getDb().prepare(
      `SELECT id FROM tasks WHERE journey_id = ? AND kind = 'decide' ORDER BY created_at DESC LIMIT 1`
    ).get(r.journeyId).id;

    w.step(60e3);
    const first = await w.scheduler.tick({ budget: 3 });
    const deferResult = first.results.find(x => x.id === taskId);
    assert.ok(deferResult, 'decide 任务应被认领');
    assert.equal(deferResult.result, 'defer', '未到截止 → 正常等待，不是错误重试');
    assert.equal(deferResult.deferReason, 'awaiting_signal_deadline');

    // defer 按明确 dueAt 排程：不轮询、不退避、不记错误
    const afterDefer = w.store.getTask(taskId);
    assert.equal(afterDefer.status, 'pending');
    assert.equal(afterDefer.due_at, dueAt, '重新排到信号截止时刻');
    assert.equal(afterDefer.last_error, null, '正常等待不记错误');

    // 截止前反复 tick：按 dueAt 等待，不反复认领，也不累加错误重试次数
    for (let i = 0; i < 10 && w.now() < dueAt; i++) {
      w.step(Math.floor((dueAt - w.now()) / 12));   // 分 12 段逼近截止
      await w.scheduler.tick({ budget: 3 });
    }
    const j = w.store.getJourney(r.journeyId);
    assert.notEqual(j.status, 'paused', '正常等待不应导致暂停');
    assert.equal(w.store.getTask(taskId).attempts, 1, '反复等待不累加错误重试次数');

    // 到达截止后：同一件遭遇由 JEV 在原候选中继续决策
    w.step(2 * 60e3);
    await w.drain(10);
    const encAfter = w.store.getEncounter(enc.id);
    assert.ok(['decided', 'resolved'].includes(encAfter.status),
      `到期后应继续推进，实际 ${encAfter.status}`);
  } finally { await w.close(); }
});

test('真实错误按退避重试并如实暂停（与正常等待区分）', async () => {
  const w = world('retry-fail', {
    scripts: baseScripts({
      [MODEL_OP.OPENING]: () => ({ __error: true, message: '模型持续失败' })
    })
  });
  try {
    const r = w.commands.release.execute({ ownerKey: 'A', input: { species: 'koi', water: 'xihu', feeling: '烦' } });
    for (let i = 0; i < 12; i++) {
      w.step(10 * 60e3);
      await w.scheduler.tick({ budget: 3 });
    }
    const j = w.store.getJourney(r.journeyId);
    assert.equal(j.status, 'paused');
    assert.equal(j.pause_reason, 'task_retry_exhausted');

    const sys = w.store.getMessages(r.journeyId).find(m => m.kind === 'system');
    assert.ok(sys, '有如实的服务提示');
    assert.ok(!sys.text.includes('它决定'), '不是伪装的生物来信');

    // 失败的真实尝试必须记账
    const calls = w.store.getModelCalls(r.journeyId);
    assert.ok(calls.some(c => c.status === 'error'), '失败尝试入账');
  } finally { await w.close(); }
});

// ======== 预算 ========

test('预算与台账：识别也记账；无余额不开新请求；预算拒绝单独记录', async () => {
  const prev = process.env.J_MAX_MODEL_CALLS;
  process.env.J_MAX_MODEL_CALLS = '3';
  try {
    const w = world('budget');
    try {
      const r = w.commands.release.execute({ ownerKey: 'A', input: { species: 'koi', water: 'xihu', feeling: '烦' } });
      await w.drain(12);

      const calls = w.store.getModelCalls(r.journeyId);
      assert.ok(calls.some(c => c.kind === MODEL_OP.SITUATION_RECOGNITION), '处境识别入账');

      const real = calls.filter(c => c.status === 'ok' || c.status === 'error');
      assert.ok(real.length <= 3, `实际网络尝试不超过预算，实际 ${real.length}`);

      const j = w.store.getJourney(r.journeyId);
      assert.ok(['active', 'paused'].includes(j.status));
      if (j.status === 'paused') assert.equal(j.pause_reason, 'budget_exhausted');
    } finally { await w.close(); }
  } finally {
    if (prev == null) delete process.env.J_MAX_MODEL_CALLS; else process.env.J_MAX_MODEL_CALLS = prev;
  }
});

// ======== 所有权与公开资源 ========

test('跨 owner 读写一律拒绝；公共脉搏不含用户原话', async () => {
  const w = world('ownership');
  let server, base;
  try {
    const r = w.commands.release.execute({ ownerKey: 'A', input: { species: 'koi', water: 'xihu', feeling: '秘密烦恼：我的项目名' } });
    server = http.createServer(w.app);
    await new Promise(res => server.listen(0, res));
    base = `http://127.0.0.1:${server.address().port}`;

    // B 读 A 的旅程 → 404
    const leak = await fetch(`${base}/api/journey/${r.journeyId}`);
    assert.equal(leak.status, 404);

    // B 结束 A 的旅程 → 404
    const endLeak = await fetch(`${base}/api/journey/${r.journeyId}/end`, { method: 'POST' });
    assert.equal(endLeak.status, 404);
    assert.equal(w.store.getJourney(r.journeyId).status, 'preparing', '越权操作未生效');

    // 公共脉搏不含原话
    const pulse = await (await fetch(`${base}/api/world/pulse`)).json();
    assert.ok(!JSON.stringify(pulse).includes('秘密烦恼'), '脉搏不泄漏用户原话');
    assert.ok(!JSON.stringify(pulse).includes('owner_key'), '脉搏不泄漏归属键');
  } finally {
    if (server) { server.closeAllConnections?.(); await new Promise(res => server.close(res)); }
    await w.close();
  }
});

test('静态服务只公开 H5 与公共资源：源码、数据库、legacy、fixture 控制面不可达', async () => {
  const w = world('static');
  let server, base;
  try {
    server = http.createServer(w.app);
    await new Promise(res => server.listen(0, res));
    base = `http://127.0.0.1:${server.address().port}`;

    // —— 公开资源必须真的可达（否则收紧过头就成了功能回归）——
    for (const p of [
      '/',
      '/vendor/three.min.js',
      '/globe3d.js',
      '/globe-config.json',
      '/world-land.json'
    ]) {
      const res = await fetch(`${base}${p}`);
      assert.equal(res.status, 200, `公开资源应可访问：${p}`);
    }

    // 私有路径一律不可达
    for (const p of [
      '/package.json',
      '/serving/adapters/store.js',
      '/serving/entrypoints/runtime.js',
      '/shared/contracts/dto.js',
      '/tests/helpers/world.js',
      '/legacy/anything.js',
      '/data/data.db',
      '/data/.env',
      '/tooling/boundary-check.js',
      '/docs/HANDOFF-Agent工程环境改造.md'
    ]) {
      const res = await fetch(`${base}${p}`);
      assert.notEqual(res.status, 200, `私有路径不应可访问：${p}`);
    }
  } finally {
    if (server) { server.closeAllConnections?.(); await new Promise(res => server.close(res)); }
    await w.close();
  }
});
