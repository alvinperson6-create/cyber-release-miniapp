// 测试共享工具：隔离 DB + 虚拟时钟 + LLM/JEV 桩
//
// 关键：必须在 require 之前替换 jev 模块导出（orchestrator/situations 在加载期解构）。
// node --test 每个文件独立进程，模块状态互不污染。

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

function tmpDbPath(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `crsv2-${tag}-`));
  return path.join(dir, 'test.db');
}

// LLM 桩路由：按 system 提示词特征分发到场景脚本
function llmKindOf(system) {
  const s = String(system || '');
  if (s.includes('第一个具体遭遇') || s.includes('轻量目标')) return 'opening';
  if (s.includes('换一个真正不同的两难') || s.includes('机制不同的新遭遇')) return 'reproposal';
  if (s.includes('下一次具体遭遇')) return 'proposal';
  if (s.includes('结算这次行动') || s.includes('结算这次行动的环境后果'.slice(0, 6))) return 'settlement';
  if (s.includes('很短的信号')) return 'signal';
  if (s.includes('写一封信')) return 'letter';
  return 'unknown';
}

/**
 * 建立一个桩世界。
 * @param {object} opts
 *   now: 虚拟时钟起点
 *   situations: (state, questions) => answers  // 处境识别（默认 task_overload supported）
 *   llm: { opening, proposal, reproposal, settlement, signal, letter } 每项 (ctx) => JSON 字符串
 *   jevOn: 是否启用 JEV
 *   jev: { decide, contact, settlementCheck, letterCheck } 每项 (state, questions) => answers
 */
function createWorld(opts = {}) {
  const T0 = opts.now ?? 1750000000000;
  process.env.DB_PATH = tmpDbPath(opts.tag || 'w');

  const clock = require('../../server/clock');
  let vt = T0;
  clock.setNow(() => vt);

  const jev = require('../../server/jev');
  const jevState = { on: opts.jevOn !== false, calls: [], decideSeq: 0, contactSeq: 0 };
  jev.isJeVEnabled = () => jevState.on;
  jev.jevJudge = async (state, questions) => {
    jevState.calls.push({ state: String(state).slice(0, 4000), q: Object.keys(questions) });
    const answers = {};
    if (questions.action) {
      const script = opts.jev?.decide;
      const choice = typeof script === 'function'
        ? script(state, questions, jevState.decideSeq++)
        : (Array.isArray(script) ? script[Math.min(jevState.decideSeq++, script.length - 1)] : (script ?? 'a1'));
      answers.action = { choice, probabilities: {}, confidence: 0.9 };
    }
    if (questions.contact) {
      const script = opts.jev?.contact;
      const choice = typeof script === 'function'
        ? script(state, questions, jevState.contactSeq++)
        : (Array.isArray(script) ? script[Math.min(jevState.contactSeq++, script.length - 1)] : (script ?? 'continue'));
      answers.contact = { choice, probabilities: {}, confidence: 0.9 };
    }
    if (questions.action_consistency) {
      const r = opts.jev?.settlementCheck;
      answers.action_consistency = { noul: typeof r === 'function' ? r(state) : (r ?? 0.05) };
    }
    if (questions.fabricated_user_facts) {
      const r = opts.jev?.letterCheck;
      const v = typeof r === 'function' ? r(state) : (r ?? { fabricated: 0.05, demeaning: 0.05, conflict: 0.05 });
      answers.fabricated_user_facts = { noul: v.fabricated ?? 0.05 };
      answers.demeaning_user = { noul: v.demeaning ?? 0.05 };
      answers.ledger_conflict = { noul: v.conflict ?? 0.05 };
    }
    // 处境识别（situations.js 的 16 问）
    if (questions.task_overload__stance) {
      const fn = opts.situations;
      if (fn) {
        Object.assign(answers, fn(state, questions));
      } else {
        for (const q of Object.keys(questions)) {
          if (q.endsWith('__stance')) answers[q] = { choice: 'unexpressed', probabilities: {}, confidence: 0.9 };
          if (q.endsWith('__evidence')) answers[q] = { choice: 'none', probabilities: {} };
        }
        answers.task_overload__stance = { choice: 'supported', probabilities: {}, confidence: 0.9 };
        answers.task_overload__evidence = { choice: 's1', probabilities: {} };
      }
    }
    return { answers, usage: { input_tokens: 1, output_tokens: 1 }, model: 'jev-stub', latencyMs: 1 };
  };

  const ai = require('../../server/ai');
  const llmState = { calls: [] };
  const scripts = opts.llm || {};
  ai.chatCompletion = async (messages, callOpts = {}) => {
    const system = messages[0]?.content || '';
    const user = messages[1]?.content || '';
    const kind = llmKindOf(system);
    llmState.calls.push({ kind, system: system.slice(0, 400), user: user.slice(0, 1500), temperature: callOpts.temperature });
    const script = scripts[kind];
    if (!script) throw new Error(`llm stub missing for kind=${kind}`);
    const out = typeof script === 'function' ? script({ system, user, seq: llmState.calls.length, temperature: callOpts.temperature }) : script;
    if (out && out.__error) { const e = new Error(out.message || 'stub error'); throw e; }
    return {
      content: typeof out === 'string' ? out : JSON.stringify(out),
      usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 },
      model: 'llm-stub', finishReason: 'stop', latencyMs: 2
    };
  };

  const db = require('../../server/db');
  db.closeDb(); // 同进程内多个 world 互不共享 SQLite 实例
  db.initDb();
  const orchestrator = require('../../server/orchestrator');
  const scheduler = require('../../server/scheduler');

  return {
    db, orchestrator, scheduler, clock, jevState, llmState,
    step(ms) { vt += ms; return vt; },
    setTime(v) { vt = v; return v; },
    now: () => vt,
    jevSet(on) { jevState.on = on; },
    // 便捷：推进调度直到没有 pending 任务；空闲时把虚拟时钟跳到最近到期点。
    // stopWhen() 返回 true 时提前停下（供测试在流程中途插入用户操作）。
    async drain(n = 40, { budget = 3, stopWhen } = {}) {
      let ran = 0;
      for (let i = 0; i < n; i++) {
        if (stopWhen && stopWhen()) break;
        const r = await scheduler.tick({ budget });
        ran += r.claimed;
        if (r.claimed) continue;
        if (stopWhen && stopWhen()) break;
        const next = db.getDb().prepare(`SELECT MIN(due_at) AS t FROM tasks WHERE status = 'pending'`).get().t;
        if (next == null) break;
        vt = Math.max(vt + 1, next + 1);
      }
      return ran;
    }
  };
}

// 常用 LLM 输出脚本
function proposalJson(over = {}) {
  return {
    title: over.title || '水草的搬家请求',
    situation: over.situation || '一丛水草拦住去路， roots 泡坏了，请它帮忙搬到浅滩，今晚就要。',
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

module.exports = { createWorld, proposalJson, llmKindOf, tmpDbPath };
