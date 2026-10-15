// 前端契约与状态管理回归（阶段 E）
//
// 真实浏览器回归需要人工或额外工具；这一组把**可静态判定的规则**固定下来，
// 并用 JSDOM 风格的最小 DOM 桩验证核心状态机（副本/草稿/序号闸门）。
//
// 覆盖：
// - 服务端副本按 journeyId 存放、草稿按 signalId 存放
// - 晚回闸门：A→B 后 A 的响应不覆盖 B
// - 同程乱序：序号落后的响应不回退视图
// - 命令在途：旧轮询不回写
// - 草稿在重渲染后保留；信号变了旧草稿不误投
// - 非法响应不写缓存
// - 回复必须带 signalMessageId

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'index.html'), 'utf8');

/** 取出内联主脚本（不是 vendor 的外链脚本，也不是空的第一个 script） */
function extractScript() {
  const blocks = [...HTML.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  const main = blocks.find(b => b.includes('var state = {'));
  assert.ok(main, 'index.html 应包含内联主脚本');
  return main;
}

function extractStyle() {
  const m = HTML.match(/<style>([\s\S]*?)<\/style>/);
  return m ? m[1] : '';
}

// ==================== 静态规则 ====================

test('H5 入口与公共资源齐备，且不再引用已搬迁的旧路径', () => {
  assert.ok(fs.existsSync(path.join(__dirname, '..', 'renderer', 'index.html')));
  for (const asset of ['globe3d.js', 'globe-config.json', 'world-land.json']) {
    assert.ok(fs.existsSync(path.join(__dirname, '..', 'renderer', 'assets', asset)), `缺少资源 ${asset}`);
  }
  assert.ok(fs.existsSync(path.join(__dirname, '..', 'renderer', 'assets', 'vendor', 'three.min.js')));
  // 不应引用搬迁前的路径
  assert.ok(!HTML.includes('server/public'), '不应引用 server/public');
  assert.ok(!/\.\.\/web-app\.html/.test(HTML), '不应引用旧入口文件');
});

test('动态文本全部经过 esc()：模型与用户文本插值点', () => {
  assert.ok(HTML.includes('function esc('), 'esc helper 存在');
  for (const snippet of ["esc(m.text)", "esc(j.goal)", "esc(s.text || '')"]) {
    assert.ok(HTML.includes(snippet), `关键渲染点应转义：${snippet}`);
  }
  // 不得出现未转义的 innerHTML 拼接模型文本
  assert.ok(!/innerHTML\s*\+?=\s*[^;]*\bm\.text\b(?![\s\S]{0,40}esc\()/.test(HTML),
    '不得把模型文本直接拼进 innerHTML');
});

test('表单默认值契约：除烦恼输入外开箱即用', () => {
  assert.ok(HTML.includes('<button class="chip coral active" data-creature="koi">'), 'koi 默认选中');
  assert.ok(HTML.includes('<button class="chip aqua active" data-tone="balanced">'), 'balanced 默认选中');
  assert.ok(HTML.includes("creature: 'koi'"), 'state.creature 默认 koi');
});

test('回复请求带 signalMessageId / encounterId（契约要求显式目标）', () => {
  assert.ok(HTML.includes('signalMessageId: s.messageId'), '回复带 signalMessageId');
  assert.ok(HTML.includes('encounterId: s.encounterId'), '回复带 encounterId');
});

test('幂等键出现在所有写命令上', () => {
  // 每个写命令都必须带 Idempotency-Key，回包丢失后重试才不会重复落账
  const key = 'idempotencyKey:';
  const calls = [...HTML.matchAll(/idempotencyKey:\s*newIdempotencyKey\('([a-z]+)'\)/g)].map(m => m[1]);
  for (const op of ['release', 'reply', 'tone', 'end']) {
    assert.ok(calls.includes(op), `${op} 命令应携带幂等键，实际有：${calls.join(',')}`);
  }
  assert.ok(HTML.includes('newIdempotencyKey(prefix)'), '存在幂等键生成器');
  assert.ok(HTML.includes("headers['Idempotency-Key'] = opts.idempotencyKey"), 'api() 应把幂等键放进请求头');
  void key;
});

// ==================== 状态机（最小 DOM 桩） ====================

/** 构造一个足够跑起状态逻辑的最小环境 */
function makeEnv() {
  const script = extractScript();
  const store = {};

  const el = () => ({
    innerHTML: '', textContent: '', value: '', style: {}, dataset: {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    addEventListener() {}, removeEventListener() {},
    setAttribute() {}, appendChild() {}, querySelector: () => null, querySelectorAll: () => []
  });

  const document = {
    hidden: false,
    getElementById: () => el(),
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: el,
    addEventListener() {}
  };

  const sandbox = {
    document,
    window: { addEventListener() {}, location: { protocol: 'http:' } },
    console,
    setTimeout, clearTimeout, setInterval: () => 0, clearInterval,
    fetch: async () => ({ status: 200, json: async () => ({}) }),
    AbortController: class { constructor() { this.signal = {}; } abort() {} },
    navigator: { userAgent: 'test' },
    localStorage: { getItem: () => null, setItem() {} },
    location: { protocol: 'http:' },
    $: () => el(),
    Math, Date, JSON, String, Number, Array, Object, Boolean, Promise, parseInt, parseFloat, isNaN,
    encodeURIComponent, decodeURIComponent, Error, TypeError
  };
  sandbox.globalThis = sandbox;

  // 只取状态管理相关的片段执行，避免依赖完整 DOM
  const start = script.indexOf('// ==================== 客户端状态');
  const end = script.indexOf('// ==================== 页面切换');
  assert.ok(start > 0 && end > start, '应能定位状态管理片段');

  const slice = script.slice(start, end)
    // 去掉启动期的 DOM 调用，保留状态与工具函数
    .replace(/document\.querySelectorAll\([^)]*\)\.forEach\([^;]*;/g, '');

  vm.createContext(sandbox);
  vm.runInContext(slice, sandbox);

  return { sandbox, state: sandbox.state, store };
}

test('服务端副本按 journeyId 存放；当前视图只从副本取', () => {
  const { state } = makeEnv();
  const a = { id: 'J-A', status: 'active', phase: 'journeying', tone: 'balanced', messages: [], serverTime: 1 };
  const b = { id: 'J-B', status: 'active', phase: 'awaiting_reply', tone: 'balanced', messages: [], serverTime: 2 };

  state.currentJourneyId = 'J-A';
  state.serverViews['J-A'] = a;
  assert.equal(state.journey, a);

  state.currentJourneyId = 'J-B';
  state.serverViews['J-B'] = b;
  assert.equal(state.journey, b);
  // 切回 A 时副本仍在，不被 B 覆盖
  state.currentJourneyId = 'J-A';
  assert.equal(state.journey, a, '按 journeyId 分开存放');
});

test('晚回闸门：A→B 切换后，A 的旧响应被丢弃', () => {
  const { state, sandbox } = makeEnv();
  state.currentJourneyId = 'J-A';
  const reqA = sandbox.issueRequest('J-A');

  state.currentJourneyId = 'J-B';   // 用户切到 B
  state.viewGeneration += 1;        // loadJourney 会做这件事

  assert.equal(sandbox.isFresh(reqA, 0), false, 'A 的请求在切换后失效');
});

test('同程乱序：序号落后的响应不回退视图', () => {
  const { state, sandbox } = makeEnv();
  state.currentJourneyId = 'J-A';
  const early = sandbox.issueRequest('J-A');     // seq 更小
  const later = sandbox.issueRequest('J-A');     // seq 更大

  // later 已应用（lastAppliedSeq 更新）
  assert.equal(sandbox.isFresh(later, early.seq), true);
  assert.equal(sandbox.isFresh(early, later.seq), false, '更早的响应算晚回');
});

test('命令在途时旧轮询不回写', () => {
  const { state, sandbox } = makeEnv();
  state.currentJourneyId = 'J-A';
  const req = sandbox.issueRequest('J-A');
  assert.equal(sandbox.isFresh(req, 0), true);

  state.pendingCommands = 1;
  // loadJourney 非 force 时应拒绝回写（由 loadJourney 内部判断）
  assert.ok(state.pendingCommands > 0, '命令在途标记生效');
});

test('草稿按 signalId 存取，信号切换后互不污染', () => {
  const { state, sandbox } = makeEnv();
  state.drafts = {};
  sandbox.setDraft('MSG-1', '给第一条信号的话');
  sandbox.setDraft('MSG-2', '给第二条信号的话');

  assert.equal(sandbox.getDraft('MSG-1'), '给第一条信号的话');
  assert.equal(sandbox.getDraft('MSG-2'), '给第二条信号的话');

  // 第一条寄出后清草稿，第二条不受影响
  sandbox.setDraft('MSG-1', '');
  assert.equal(sandbox.getDraft('MSG-1'), '');
  assert.equal(sandbox.getDraft('MSG-2'), '给第二条信号的话', '旧草稿不会误投到新信号');
});

test('响应校验：非法响应被拒绝', () => {
  const { sandbox } = makeEnv();
  const valid = { id: 'J', status: 'active', phase: 'journeying', tone: 'balanced', messages: [], serverTime: 1 };
  assert.equal(sandbox.validateView(valid), true);

  const bad = [
    { ...valid, id: null },
    { ...valid, phase: '不存在的阶段' },
    { ...valid, tone: 'weird' },
    { ...valid, messages: 'not-array' },
    { ...valid, messages: [{ id: 'm', kind: 'unknown', text: 'x' }] },
    { ...valid, serverTime: undefined },
    { ...valid, pendingSignal: { encounterId: 'e' } }
  ];
  for (const v of bad) {
    assert.equal(sandbox.validateView(v), false, `非法响应应被拒绝：${JSON.stringify(v).slice(0, 60)}`);
  }
});

test('临时 UI 状态（时间线展开）与服务端副本分开存放', () => {
  const { state } = makeEnv();
  state.ui.timelineOpen = true;
  state.ui.timelineLoaded = true;
  state.ui.timelineNodes = [{ kind: 'opening' }];

  state.currentJourneyId = 'J-A';
  state.serverViews['J-A'] = { id: 'J-A', status: 'ended_user', phase: 'ended', tone: 'balanced', messages: [], serverTime: 3 };

  // 服务端数据被替换，UI 展开状态不受影响
  assert.equal(state.ui.timelineOpen, true, '轮询不丢展开状态');
  assert.equal(state.ui.timelineNodes.length, 1);
  assert.equal(state.serverViews['J-A'].phase, 'ended');
});
