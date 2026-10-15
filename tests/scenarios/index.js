// 赛博放生 · 固定场景
//
// 阶段 B 的目的：执行者（含后续 Agent）能用**一条实际命令**进入
// preparing、待回应信号、来信与已结束等场景，自己复现并观察，
// 不需要用户手动制造条件。
//
// 纪律：
// - 每个场景走真实主链：实际命令 → 生产任务 → 固定 adapter 响应
//   → 生产校验/提交 → HTTP 读取
// - 默认零真实外部调用（全部固定 adapter）
// - reset 只作用于该次隔离数据（临时库），不碰生产库
// - fixture 控制面不存在于生产 API

const { createWorld, baseScripts, baseHandlers, proposalJson } = require('../helpers/world');
const { MODEL_OP } = require('../../shared/contracts/enums');

/** 场景定义：每个场景声明如何推进到目标状态 */
const SCENARIOS = {
  preparing: {
    title: '放生后待开局',
    describe: '已建程但模型尚未产出目标：命令已返回 preparing 回执。',
    async build(w) {
      const r = w.commands.release.execute({
        ownerKey: 'A', input: { species: 'koi', water: 'xihu', feeling: '明天要答辩，紧张到胃疼', tone: 'balanced' }
      });
      return { journeyId: r.journeyId };
    }
  },

  awaiting_signal: {
    title: '待回应信号',
    describe: '生物已寄出一个可回应的信号，等用户回复或到期。',
    handlers: baseHandlers({
      [MODEL_OP.ACTION_DECISION]: () => ({
        action: { choice: 'send_signal', probabilities: {}, confidence: 0.9 },
        signal_urgency: { choice: 'patient', probabilities: {}, confidence: 0.9 }
      })
    }),
    async build(w) {
      const r = w.commands.release.execute({
        ownerKey: 'A', input: { species: 'koi', water: 'xihu', feeling: '事情太多了做不完', tone: 'balanced' }
      });
      await w.drain(2, { advanceClock: false });
      w.step(4 * 60e3);
      await w.drain(2, { advanceClock: false });
      return { journeyId: r.journeyId };
    }
  },

  settled: {
    title: '已结算（有来信前的世界）',
    describe: '完成一次决策与结算，事实与机制卡已落账。',
    async build(w) {
      const r = w.commands.release.execute({
        ownerKey: 'A', input: { species: 'koi', water: 'xihu', feeling: '又加班到十一点', tone: 'balanced' }
      });
      await w.drain(6);
      return { journeyId: r.journeyId };
    }
  },

  letter: {
    title: '有阶段来信',
    describe: '生物寄过一封阶段经历来信，旅程继续。',
    handlers: baseHandlers({
      [MODEL_OP.SETTLEMENT_CHECK]: () => ({
        action_consistency: { noul: 0.05 },
        contact: { choice: 'letter', probabilities: {}, confidence: 0.9 }
      })
    }),
    async build(w) {
      const r = w.commands.release.execute({
        ownerKey: 'A', input: { species: 'turtle', water: 'baikal', feeling: '凌晨三点还睡不着', tone: 'gentle' }
      });
      await w.drain(14);
      return { journeyId: r.journeyId };
    }
  },

  ended_natural: {
    title: '自然收束',
    describe: '旅程自然结束，回顾时间线已开放。',
    handlers: baseHandlers({
      [MODEL_OP.SETTLEMENT_CHECK]: () => ({
        action_consistency: { noul: 0.05 },
        contact: { choice: 'final_letter', probabilities: {}, confidence: 0.9 }
      })
    }),
    async build(w) {
      const r = w.commands.release.execute({
        ownerKey: 'A', input: { species: 'cloud', water: 'pacific', feeling: '莫名烦躁，说不上来', tone: 'absurd' }
      });
      await w.drain(18);
      return { journeyId: r.journeyId };
    }
  },

  ended_user: {
    title: '用户主动结束',
    describe: '用户已结束本程；可验证在途模型结果不再提交。',
    async build(w) {
      const r = w.commands.release.execute({
        ownerKey: 'A', input: { species: 'koi', water: 'xihu', feeling: '项目明天上线，手心出汗', tone: 'balanced' }
      });
      await w.drain(3);
      w.commands.endJourney.execute({ ownerKey: 'A', journeyId: r.journeyId, input: {} });
      return { journeyId: r.journeyId };
    }
  },

  paused: {
    title: '服务暂停',
    describe: '模型连续失败后如实暂停，不伪装成生物自主收束。',
    scripts: baseScripts({ [MODEL_OP.OPENING]: () => ({ __error: true, message: '模型不可用' }) }),
    async build(w) {
      const r = w.commands.release.execute({
        ownerKey: 'A', input: { species: 'koi', water: 'xihu', feeling: '烦', tone: 'balanced' }
      });
      for (let i = 0; i < 12; i++) {
        w.step(10 * 60e3);
        await w.scheduler.tick({ budget: 3 });
      }
      return { journeyId: r.journeyId };
    }
  }
};

const SCENARIO_NAMES = Object.keys(SCENARIOS);

/**
 * 启动一个场景。
 * @param name SCENARIO_NAMES 之一
 * @param opts.mode 'seeded-view' 只用于 UI 快速展示；'main-chain' 是主链（默认）
 */
async function startScenario(name, opts = {}) {
  const def = SCENARIOS[name];
  if (!def) {
    throw new Error(`unknown scenario: ${name}\navailable: ${SCENARIO_NAMES.join(', ')}`);
  }

  const w = createWorld({
    tag: `scenario-${name}`,
    scripts: baseScripts(def.scripts),
    handlers: def.handlers || baseHandlers(),
    mode: opts.mode || 'main-chain'
  });

  const built = await def.build(w);

  // —— 只读快照：一次 HTTP 层读取得到的主链结果 ——
  const view = w.queries.getJourneyView({ ownerKey: 'A', journeyId: built.journeyId });
  const journey = w.store.getJourney(built.journeyId);
  const timeline = journey && ['ended_user', 'ended_natural', 'aborted'].includes(journey.status)
    ? w.queries.getJourneyTimeline({ ownerKey: 'A', journeyId: built.journeyId })
    : null;

  return {
    scenario: name,
    mode: opts.mode || 'main-chain',
    title: def.title,
    describe: def.describe,
    dbPath: w.dbPath,
    journeyId: built.journeyId,
    world: w,

    /** 摘要：可直接贴进验证记录 */
    summary() {
      return {
        scenario: name,
        mode: opts.mode || 'main-chain',
        journeyId: built.journeyId,
        status: journey.status,
        phase: view?.phase ?? null,
        goal: view?.goal ?? null,
        messages: (view?.messages || []).map(m => ({ kind: m.kind, status: m.status, chars: m.text.length })),
        pendingSignal: view?.pendingSignal
          ? { encounterId: view.pendingSignal.encounterId, dueAt: view.pendingSignal.dueAt, replied: view.pendingSignal.replied }
          : null,
        factsCount: view?.factsCount ?? 0,
        timelineNodes: timeline?.ok ? timeline.timeline.nodes.length : null,
        modelCalls: w.store.countModelCalls(built.journeyId),
        externalCalls: 0,          // 固定 adapter：零真实外部调用
        dbPath: w.dbPath
      };
    },

    /** 步进：推进虚拟时钟并跑一个调度周期 */
    async step(ms = 60e3, { budget = 3 } = {}) {
      w.step(ms);
      const r = await w.scheduler.tick({ budget });
      return { at: r.at, claimed: r.claimed, results: r.results };
    },

    /** 排干：推进到没有到期任务 */
    async advance(maxRounds = 30) {
      return w.drain(maxRounds);
    },

    /** HTTP 层读取（走真实路由与序列化） */
    async httpRead() {
      const http = require('node:http');
      const server = http.createServer(w.app);
      await new Promise(res => server.listen(0, res));
      const port = server.address().port;
      try {
        const r1 = await fetch(`http://127.0.0.1:${port}/api/release`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ species: 'koi', water: 'xihu', feeling: '读取用旅程', tone: 'balanced' })
        });
        const cookie = (r1.headers.get('set-cookie') || '').split(';')[0];
        const res = await fetch(`http://127.0.0.1:${port}/api/journey/${built.journeyId}`, {
          headers: { Cookie: cookie }
        });
        return { status: res.status, body: await res.json() };
      } finally {
        server.closeAllConnections?.();
        await new Promise(res => server.close(res));
      }
    },

    async reset() { await w.close(); }
  };
}

module.exports = { SCENARIOS, SCENARIO_NAMES, startScenario };
