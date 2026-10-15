// 赛博放生 · 测试/场景共享装配
//
// 阶段 B 的要求：
// - 实例级依赖注入：store、clock、模型 adapter、图片 adapter 全部替换
// - 两个 runtime 的库、时间与桩互不污染
// - **不依赖 require 顺序、不替换模块导出、不按提示词文案分流**
//
// 与旧 helpers/world.js 的关键差别：
//   旧：require('../../server/jev') 后直接覆盖 jev.jevJudge —— 全局副作用，
//       依赖 orchestrator 加载期解构，多 world 互相污染
//   新：createRuntime({ jev: fakeJev }) —— 显式注入，两个实例完全隔离
//
// 模型操作有显式名称（shared/contracts/enums 的 MODEL_OP）。
// fixture 遇到未知操作名直接抛错，绝不回退真实网络。

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createRuntime } = require('../../serving/entrypoints/runtime');
const { createApp } = require('../../serving/entrypoints/app');
const { createClock, virtualClock } = require('../../serving/adapters/clock');
const { MODEL_OP, MODEL_OP_NAMES } = require('../../shared/contracts/enums');

function tmpDbPath(tag = 'w') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `cyber-release-${tag}-`));
  return path.join(dir, 'test.db');
}

/**
 * 固定 adapter：按显式操作名供数。
 *
 * @param scripts { [opName]: string | object | (ctx) => any | {__error, message} | [..] }
 *                 未提供的操作名调用会抛错 —— 这正是"未知操作在 fixture 中明确失败"
 */
function createFixtureModel(scripts = {}, { label = 'fixture' } = {}) {
  const calls = [];
  const scriptOf = (op) => {
    if (!Object.prototype.hasOwnProperty.call(scripts, op)) {
      if (!MODEL_OP_NAMES.includes(op)) {
        throw new Error(`[${label}] unknown model operation: ${op}`);
      }
      throw new Error(`[${label}] fixture missing script for op=${op}`);
    }
    return scripts[op];
  };

  async function invoke({ op, messages, temperature, journeyId, taskId, encounterId, operationId, budget, now }) {
    if (!MODEL_OP_NAMES.includes(op)) throw new Error(`[${label}] unknown model operation: ${op}`);
    if (budget && budget.allowed === false) {
      calls.push({ op, denied: true, journeyId });
      return { ok: false, error: budget.reason || 'budget_exhausted', budgetDenied: true };
    }
    const script = scriptOf(op);
    const idx = calls.filter(c => c.op === op).length;
    const out = Array.isArray(script) ? script[Math.min(idx, script.length - 1)]
      : (typeof script === 'function' ? script({ messages, temperature, seq: idx, journeyId, taskId, encounterId })
        : script);
    calls.push({ op, journeyId, taskId, encounterId, operationId, now, temperature });

    if (out && out.__error) {
      // 真实失败：调用方会记 error 并走重试/暂停
      const err = new Error(out.message || 'fixture error');
      err.__fixture = true;
      return { ok: false, error: err.message, meta: { latencyMs: 1 } };
    }
    return {
      ok: true,
      content: typeof out === 'string' ? out : JSON.stringify(out),
      meta: { model: 'fixture-llm', usage: { input_tokens: 10, output_tokens: 20 }, latencyMs: 2 }
    };
  }

  return { invoke, isEnabled: () => true, calls, getConfig: () => ({ provider: 'fixture', model: 'fixture-llm', apiKey: 'fixture' }) };
}

/** 固定 JEV adapter：按问题 key 回答 */
function createFixtureJev(handlers = {}, { label = 'fixture-jev' } = {}) {
  const calls = [];
  let enabled = true;
  const seq = {};

  async function judge({ op, state, questions, journeyId, taskId, encounterId, operationId, budget, now }) {
    if (budget && budget.allowed === false) {
      calls.push({ op, denied: true });
      return { available: false, budgetDenied: true, reason: budget.reason };
    }
    if (!enabled) return { available: false, reason: 'DISABLED' };
    calls.push({ op, state: String(state).slice(0, 4000), questionKeys: Object.keys(questions || {}), journeyId, taskId, encounterId, now });
    const n = (seq[op] = (seq[op] || 0) + 1) - 1;

    const answers = {};
    const handler = handlers[op];
    if (handler) {
      Object.assign(answers, typeof handler === 'function' ? handler({ state, questions, seq: n }) : handler);
    }
    // 通用默认：按问题类型补齐结构
    for (const [id, q] of Object.entries(questions || {})) {
      if (answers[id]) continue;
      if (q.type === 'noul') answers[id] = { noul: 0.05 };
      else if (q.type === 'choice') answers[id] = { choice: Object.keys(q.criteria || {})[0], probabilities: {}, confidence: 0.9 };
      else if (q.type === 'score') answers[id] = { score: 0.5 };
    }
    return { available: true, answers, usage: { input_tokens: 1, output_tokens: 1 }, model: 'fixture-jev', latencyMs: 1 };
  }

  return {
    judge, calls,
    isEnabled: () => enabled,
    setEnabled: (v) => { enabled = v; },
    getConfig: () => ({ apiKey: enabled ? 'fixture' : '', model: 'fixture-jev' })
  };
}

/** 固定配图 adapter：永不联网 */
function createFixtureImage(result = null) {
  const calls = [];
  return {
    calls,
    async generate(opts) { calls.push(opts); return typeof result === 'function' ? result(opts) : result; }
  };
}

/**
 * 建立一个隔离世界。
 *
 * @param opts.now       虚拟时钟起点
 * @param opts.tag       临时库标签
 * @param opts.dbPath    指定数据库路径（默认临时库）
 * @param opts.textModel 固定文本模型（默认按 scripts 建）
 * @param opts.jev       固定 JEV（默认按 handlers 建）
 * @param opts.image     固定配图
 * @param opts.scripts   文本模型脚本（MODEL_OP → 输出）
 * @param opts.handlers   JEV 处理器（MODEL_OP → answers）
 */
function createWorld(opts = {}) {
  const T0 = opts.now ?? 1750000000000;
  const dbPath = opts.dbPath || tmpDbPath(opts.tag || 'w');
  const vt = virtualClock(T0);
  const clock = createClock();
  clock.setNow(() => vt.now());

  const textModel = opts.textModel || createFixtureModel(opts.scripts || {});
  const jev = opts.jev || createFixtureJev(opts.handlers || {});
  const image = opts.image || createFixtureImage(opts.imageResult ?? null);

  const quietLogger = {
    log: () => {}, warn: () => {}, error: () => {}
  };
  if (opts.verbose) quietLogger.log = console.log;

  const runtime = createRuntime({
    dbPath, clock, textModel, jev, image,
    logger: quietLogger,
    mode: opts.mode || 'test'
  });

  const app = createApp(runtime, { staticDir: opts.staticDir });

  return {
    runtime, app, store: runtime.store, clock, textModel, jev, image,
    db: runtime.store, orchestrator: runtime.orchestrator,
    scheduler: runtime.scheduler, commands: runtime.commands, queries: runtime.queries,
    dbPath,
    get llmCalls() { return textModel.calls; },
    get jevCalls() { return jev.calls; },
    step(ms) { return vt.step(ms); },
    setTime(v) { return vt.set(v); },
    now: () => vt.now(),

    /**
     * 推进调度。
     * @param advanceClock 默认 true：空闲时把虚拟时钟跳到最近到期点。
     *   信号截止等场景需要 advanceClock:false，否则时钟会被直接跳过截止点。
     */
    async drain(n = 40, { budget = 3, stopWhen, advanceClock = true } = {}) {
      let ran = 0;
      for (let i = 0; i < n; i++) {
        if (stopWhen && stopWhen()) break;
        const r = await runtime.scheduler.tick({ budget });
        ran += r.claimed;
        if (r.claimed) continue;
        if (stopWhen && stopWhen()) break;
        const next = runtime.store.minPendingDueAt();
        if (next == null) break;
        if (!advanceClock) break;   // 不推进时钟：只跑当下到期的东西
        vt.set(Math.max(vt.now() + 1, next + 1));
      }
      return ran;
    },

    async close() { await runtime.stop(); }
  };
}

// ======== 常用 fixture 脚本 ========

function proposalJson(over = {}) {
  return {
    title: over.title || '水草的搬家请求',
    situation: over.situation || '一丛水草拦住去路，根都泡坏了，请它帮忙搬到浅滩，今晚就要。',
    constraints: over.constraints || ['它已经答应过螃蟹一次代班，精力有限'],
    actions: over.actions || [
      { id: 'a1', label: '连夜帮忙搬', cost: '它会错过自己预约的洋流休息' },
      { id: 'a2', label: '只送到半路', cost: '水草可能觉得它不够朋友' },
      { id: 'a3', label: '介绍潮汐帮忙', cost: '潮汐要收一片鳞片作谢礼' }
    ],
    mechanism_summary: over.mechanism_summary || {
      pressure: '同伴的请求又找上门',
      dilemma: '帮 vs 自己的休息',
      cost: '精力透支或关系紧张'
    },
    expected_fact_types: over.expected_fact_types || ['relationship']
  };
}

function settlementJson(over = {}) {
  return {
    narrative: over.narrative || '事情有了结果，它继续往前游，水草在浅滩扎下了根。',
    facts: over.facts || [{ kind: 'consequence', content: '一个具体的后果' }],
    mechanism_card: over.mechanism_card || {
      pressure: 'p', dilemma: 'd', choice_cost: 'c', lasting_consequence: 'l'
    },
    next_trigger: over.next_trigger || ''
  };
}

/** 一套能跑通 opening → decide → settle 的基础脚本 */
function baseScripts(over = {}) {
  return {
    [MODEL_OP.OPENING]: () => ({ goal: '把这片水域的日子过明白', encounter: proposalJson({ title: '遭遇' }) }),
    [MODEL_OP.PROPOSAL]: () => proposalJson({ title: '下一遭遇' }),
    [MODEL_OP.SETTLEMENT]: () => settlementJson(),
    [MODEL_OP.SIGNAL_WRITE]: () => ({ text: '一个简短的信号，问主人一句话。' }),
    [MODEL_OP.LETTER_WRITE]: () => ({ title: '信', text: '这是信的正文，叙述已经发生的事。' }),
    [MODEL_OP.FINAL_LETTER_WRITE]: () => ({ title: '最后一封', text: '这一程到此为止，谢谢你放我出来。' }),
    ...over
  };
}

function baseHandlers(over = {}) {
  return {
    [MODEL_OP.SITUATION_RECOGNITION]: () => ({}),
    [MODEL_OP.ACTION_DECISION]: () => ({
      action: { choice: 'a1', probabilities: {}, confidence: 0.9 },
      signal_urgency: { choice: 'soon', probabilities: {}, confidence: 0.9 }
    }),
    [MODEL_OP.CONTACT_CHECKPOINT]: () => ({ contact: { choice: 'continue', probabilities: {}, confidence: 0.9 } }),
    [MODEL_OP.SETTLEMENT_CHECK]: () => ({
      action_consistency: { noul: 0.05 },
      contact: { choice: 'continue', probabilities: {}, confidence: 0.9 }
    }),
    [MODEL_OP.LETTER_CHECK]: () => ({
      fabricated_user_facts: { noul: 0.05 },
      demeaning_user: { noul: 0.05 },
      ledger_conflict: { noul: 0.05 }
    }),
    [MODEL_OP.DEDUP_CHECK]: () => ({ same_mechanism: { choice: 'different', probabilities: {}, confidence: 0.9 } }),
    ...over
  };
}

module.exports = {
  createWorld, createFixtureModel, createFixtureJev, createFixtureImage,
  tmpDbPath, proposalJson, settlementJson, baseScripts, baseHandlers
};
