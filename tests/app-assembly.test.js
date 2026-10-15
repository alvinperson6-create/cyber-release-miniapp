// 装配与验证底座自测（阶段 A / B）
//
// 关键断言：
// - 导入 app.js / runtime.js 不产生副作用（不监听端口、不连生产库）
// - 生产装配与测试共用同一个 createApp
// - 两个 runtime 的库、时间与桩互不污染
// - 关闭后无遗留端口/timer

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const http = require('node:http');

const { createWorld, baseScripts, baseHandlers } = require('./helpers/world');
const { MODEL_OP } = require('../shared/contracts/enums');

test('导入装配模块无副作用：不监听端口、不启动 timer、不连生产库', async () => {
  const before = process._getActiveHandles?.().length ?? 0;
  const { createApp } = require('../serving/entrypoints/app');
  const { createRuntime } = require('../serving/entrypoints/runtime');
  assert.equal(typeof createApp, 'function');
  assert.equal(typeof createRuntime, 'function');

  const after = process._getActiveHandles?.().length ?? 0;
  assert.ok(after <= before, `导入后活跃 handle 不应增加（before=${before} after=${after}）`);
});

test('createApp(runtime) 可重复创建与关闭，无遗留端口', async () => {
  const w = createWorld({ tag: 'appsmoke', scripts: baseScripts(), handlers: baseHandlers() });
  try {
    const server = http.createServer(w.app);
    await new Promise(r => server.listen(0, r));
    const port = server.address().port;
    const health = await (await fetch(`http://127.0.0.1:${port}/api/health`)).json();
    assert.equal(health.status, 'ok');
    assert.equal(health.journeyV2, true);
    server.closeAllConnections?.();
    await new Promise(r => server.close(r));
  } finally {
    await w.close();
  }
});

test('两个 runtime 完全隔离：库、时间与桩互不污染', async () => {
  const T0 = 1750000000000;
  const a = createWorld({ tag: 'iso-a', now: T0, scripts: baseScripts(), handlers: baseHandlers() });
  const b = createWorld({ tag: 'iso-b', now: T0, scripts: baseScripts(), handlers: baseHandlers() });
  try {
    assert.notEqual(a.dbPath, b.dbPath);
    assert.notEqual(a.store.getDb(), b.store.getDb());

    const ra = a.commands.release.execute({ ownerKey: 'A', input: { species: 'koi', water: 'xihu', feeling: 'A 的烦恼' } });
    const rb = b.commands.release.execute({ ownerKey: 'B', input: { species: 'turtle', water: 'baikal', feeling: 'B 的烦恼' } });
    assert.ok(ra.ok && rb.ok);
    assert.notEqual(ra.journeyId, rb.journeyId);

    // A 的库里只有 A 的旅程（B 的旅程在另一个库）
    assert.ok(a.store.getOwnedJourney(ra.journeyId, 'A'));
    assert.equal(a.store.getOwnedJourney(rb.journeyId, 'B'), null);
    assert.ok(b.store.getOwnedJourney(rb.journeyId, 'B'));
    assert.equal(b.store.getOwnedJourney(ra.journeyId, 'A'), null);

    // 时间各自独立：推进 a 不影响 b
    const bBefore = b.now();
    a.step(60 * 60e3);
    assert.equal(b.now(), bBefore, '推进 a 的时钟不应影响 b');
    assert.equal(a.now(), T0 + 60 * 60e3);

    // 模型桩各自计数
    await a.drain(4);
    assert.ok(a.llmCalls.length > 0);
    assert.equal(b.llmCalls.length, 0, 'b 未推进则不应有模型调用');
  } finally {
    await a.close();
    await b.close();
  }
});

test('fixture 遇到未知/缺失操作名明确失败，不回退真实网络', async () => {
  const w = createWorld({
    tag: 'strict',
    // opening 脚本存在，但 settle 之后需要的 signal_write 缺失
    scripts: baseScripts({
      [MODEL_OP.SIGNAL_WRITE]: { __error: true, message: 'fixture missing script for op=signal_write' }
    }),
    handlers: baseHandlers({
      [MODEL_OP.ACTION_DECISION]: () => ({
        action: { choice: 'send_signal', probabilities: {}, confidence: 0.9 },
        signal_urgency: { choice: 'soon', probabilities: {}, confidence: 0.9 }
      })
    })
  });
  try {
    const r = w.commands.release.execute({ ownerKey: 'A', input: { species: 'koi', water: 'xihu', feeling: '烦' } });
    assert.ok(r.ok);

    // 缺脚本 → 明确失败，任务转 retry（不静默走真实模型）
    await w.drain(8);
    const enc = w.store.getLatestEncounter(r.journeyId);
    assert.ok(enc, '开局应已提交');
    assert.equal(enc.status, 'proposed', '信号生成失败时不得伪造已寄信号');

    // 台账完整记录（注入的 adapter 也走统一记账，不绕过）
    const calls = w.store.getModelCalls(r.journeyId);
    assert.ok(calls.length > 0, '应有模型调用记账');
    assert.ok(calls.every(c => c.provider === 'injected'),
      '注入 adapter 也必须经过统一记账入口');
    // 处境识别也进台账（旧实现曾绕过）
    assert.ok(calls.some(c => c.kind === MODEL_OP.SITUATION_RECOGNITION),
      '处境识别必须记账');
  } finally {
    await w.close();
  }
});

test('数据库路径锚定到配置而非模块位置', () => {
  const store = require('../serving/adapters/store');
  const prev = process.env.DB_PATH;
  process.env.DB_PATH = '/tmp/cyber-release-path-test.db';
  try {
    assert.equal(store.resolveDbPath(), '/tmp/cyber-release-path-test.db');
  } finally {
    if (prev == null) delete process.env.DB_PATH; else process.env.DB_PATH = prev;
  }
  // 未设置时落在 data/data.db，不随代码搬迁漂移
  delete process.env.DB_PATH;
  assert.ok(store.resolveDbPath().endsWith(path.join('data','data.db')) || store.resolveDbPath().endsWith(path.join('server','data.db')),
    '默认应落在 data/data.db（旧库存在时兼容读 server/data.db）');
});
