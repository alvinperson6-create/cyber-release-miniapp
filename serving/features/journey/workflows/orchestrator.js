// 赛博放生 · 旅程编排核心
//
// 分工纪律：
// - LLM 是文字世界导演：临场提出遭遇、结算后果、写信号/来信；不能替 JEV 选行动
// - JEV 是行动决策脑：JEV 不可用就重试/暂停，绝不用规则冒充
// - 程序掌握权威事实：所有落账经 commits 层，模型调用在事务外
// - 读取 API 不触发任何模型生成
// - 所有入口（HTTP、调度器、场景）共用本模块
//
// 边界（阶段 3.1）：workflow 编排读取、外部调用、校验与提交；
// 不得绕过 commit 接口直接写表。

const { SCHEDULER_RESULT, COMMIT_RESULT, MODEL_OP } = require('../../../../shared/contracts/enums');
const { guards, scaleMs, thresholds, SIGNAL_URGENCY_MINUTES } = require('../../../adapters/guards');
const { CREATURES, WATERS } = require('../../../../shared/contracts/vocabulary');
const director = require('../context/director');
const builder = require('../context/builder');
const { recognizeSituations } = require('../context/situation-recognition');
const { checkTextBoundaries } = require('../policies/text-boundary');
const textmatch = require('../policies/mechanism-similarity');
const commits = require('../commits/settlement');

const ORCHESTRATOR_VERSION = 'journey-orchestrator-v3';

// 服务节奏（可经 J_TIME_SCALE 缩放；是服务护栏，不是剧情拍板）
const PACE = {
  decideAfterProposal: () => scaleMs(3 * 60e3),
  settleAfterDecision: () => scaleMs(2 * 60e3),
  signalExpiry: () => guards.signalDeadlineMs(),
  nextAfterContact: () => scaleMs(15 * 60e3),
  letterAfterContact: () => scaleMs(2 * 60e3),
  retryLease: () => scaleMs(30e3)
};

class FlowError extends Error {
  constructor(code, message) { super(message || code); this.code = code; }
}

/**
 * 创建编排器实例。
 *
 * @param deps.store  存储适配器
 * @param deps.clock  可控时钟
 * @param deps.textModel 文本模型适配器（提供 invoke + isEnabled）
 * @param deps.jev     JEV 适配器（提供 judge + isEnabled）
 * @param deps.image   配图适配器
 * @param deps.logger  日志
 */
function createOrchestrator({ store, clock, textModel, jev, image, logger = console }) {
  // ==================== 服务护栏 ====================

  /** 安静时段：本地时间 [start, end) 内不寄信，顺延到 quietEnd */
  function effectiveSendTime(now) {
    const { start, end } = guards.quietHours();
    const d = new Date(now);
    const h = d.getHours();
    if (start === end) return now;
    const inQuiet = start < end ? (h >= start && h < end) : (h >= start || h < end);
    if (!inQuiet) return now;
    const at = new Date(d);
    at.setHours(end % 24, 0, 0, 0);
    if (at.getTime() <= now) at.setDate(at.getDate() + 1);
    return at.getTime();
  }

  /** 最小发送间隔：与上一封用户面向消息的间隔护栏 */
  function earliestSendAt(journeyId, now) {
    const last = store.lastUserFacingAt(journeyId);
    const min = guards.minIntervalMs();
    if (!last || !min) return now;
    return Math.max(now, last + min);
  }

  /** 剩余预算。并发时由 reserveBudget 原子占用（见 ledger） */
  function budgetRemaining(journeyId) {
    return guards.maxModelCalls() - store.countModelCalls(journeyId);
  }

  function budgetGate(journeyId) {
    const remaining = budgetRemaining(journeyId);
    return remaining <= 0
      ? { allowed: false, reason: 'budget_exhausted' }
      : { allowed: true };
  }

  /** 预算用尽 → 旅程如实暂停（不是生物自主收束） */
  function pauseJourney(journeyId, reason, { notice, now } = {}) {
    const t = now ?? clock.now();
    const journey = store.getJourney(journeyId);
    if (!journey) return false;
    const ok = store.updateJourney(journeyId, { status: 'paused', pause_reason: reason }, { status: journey.status });
    if (!ok) return false;
    store.cancelTasksForJourney(journeyId, t);
    store.insertMessage({
      id: store.rid('MSG'), journeyId, kind: 'system', encounterId: null,
      text: notice || `服务提示：旅程已暂停（${reason}）。这不是${CREATURES[journey.species]?.name || '生物'}的来信；恢复或结束后可再次出发。`,
      status: 'sent', sentAt: t, now: t
    });
    return true;
  }

  // ==================== JEV 调用封装 ====================

  async function jevDecideAction({ journey, encounter, motivation, facts, ontimeSupplies, lateSupplies, taskId, operationId, now }) {
    if (!jev.isEnabled()) throw new FlowError('jev_unavailable', 'JEV 未配置');
    const criteria = {};
    for (const a of encounter.proposal.actions) criteria[a.id] = `${a.label}（代价：${a.cost}）`;
    criteria.none_fit = '这些都不合适：现有选项都违背它的处境、目标或安全（触发有限重提案）';
    if (encounter.status === 'proposed') {
      criteria.send_signal = '先不行动：就这件未决处境给主人寄一个可回应的信号，等回复或到期后再决定';
    }
    const urgencyCriteria = {
      instant: '千钧一发：它马上就要面对结果，主人几分钟内回一句才算来得及',
      urgent: '很急：事情就在眼前，大约十分钟内会变',
      soon: '有些急：再拖一阵就要变了',
      unhurried: '不算急：值得等主人一会儿，但不该占它一整天',
      patient: '不急：它愿意慢慢等主人想清楚'
    };

    const state = builder.buildDecisionState({
      journey, encounter, motivation, facts, ontimeSupplies, lateSupplies,
      creatureName: CREATURES[journey.species]?.name
    });

    const r = await jev.judge({
      op: MODEL_OP.ACTION_DECISION,
      state,
      questions: {
        action: {
          type: 'choice',
          instructions: '这是一只被放生的虚拟生物，正在它的文字世界里面对一件具体遭遇。结合它的动机档案、目标和已发生事实，判断它此刻会怎么做。只从候选中选择一个。',
          criteria
        },
        signal_urgency: {
          type: 'choice',
          instructions: '（独立判断）如果它这次选择寄信号向主人求助，判断这件事对它有多急：主人最晚多久之内回一句，对它来说还算来得及？',
          criteria: urgencyCriteria
        }
      },
      journeyId: journey.id, taskId, encounterId: encounter.id, operationId, now,
      budget: budgetGate(journey.id)
    });

    if (!r.available) {
      throw new FlowError('jev_unavailable', `JEV 不可用：${r.reason || 'unknown'}`);
    }
    const choice = r.answers.action.choice;
    if (!criteria[choice]) throw new FlowError('jev_format', `JEV 返回了非法选项 ${choice}`);
    const urgencyLevel = r.answers.signal_urgency?.choice;
    const urgency = SIGNAL_URGENCY_MINUTES[urgencyLevel]
      ? { source: 'jev_urgency', level: urgencyLevel, minutes: SIGNAL_URGENCY_MINUTES[urgencyLevel] }
      : { source: 'fallback_default', level: null, minutes: null };
    return { action: choice, urgency, meta: { usage: r.usage, model: r.model, latencyMs: r.latencyMs, urgency } };
  }

  async function jevContactCheckpoint({ journey, taskId, facts, eventCount, operationId, now, extraQuestions }) {
    const criteria = {
      continue: '继续旅程：还有它想经历或未了的事',
      letter: '寄一封阶段经历来信：这段经历值得先跟主人说说',
      final_letter: '自然收束：本程的这段经历已经完整，寄最后一封经历来信然后结束'
    };
    if (eventCount >= guards.maxEvents()) return { contact: 'final_letter', source: 'event_budget' };
    if (!jev.isEnabled()) return { contact: 'continue', source: 'default_continue_judge_unavailable' };

    const state = builder.buildContactState({
      journey, motivation: store.getMotivation(journey.id), facts,
      creatureName: CREATURES[journey.species]?.name
    });
    const r = await jev.judge({
      op: MODEL_OP.CONTACT_CHECKPOINT, state,
      questions: {
        ...(extraQuestions || {}),
        contact: {
          type: 'choice',
          instructions: '刚经历完一件事。以这只生物的动机、目标和已发生的事判断：它接下来想怎么走？',
          criteria
        }
      },
      journeyId: journey.id, taskId, operationId, now, budget: budgetGate(journey.id)
    });
    if (!r.available) return { contact: 'continue', source: 'default_continue_judge_unavailable' };
    const contact = r.answers.contact?.choice;
    if (!criteria[contact]) throw new FlowError('jev_format', 'contact 非法选项');
    return { contact, source: 'jev' };
  }

  /** 窄语义检查：一次请求多个彼此独立的问题 */
  async function jevNarrowChecks({ journey, taskId, op, questions, encounterId, operationId, now }) {
    const r = await jev.judge({
      op, state: questions.state, items: undefined, questions: questions.items,
      journeyId: journey.id, taskId, encounterId, operationId, now,
      budget: budgetGate(journey.id)
    });
    if (!r.available) return { available: false, results: null };
    return { available: true, results: r.answers };
  }

  // ==================== 任务处理器 ====================

  /** 开局：识别处境 → 建动机档案 → 导演给目标+首遭遇 → 冻结 */
  async function taskOpening(task, journey, now) {
    if (journey.status !== 'preparing') return { status: SCHEDULER_RESULT.DONE };
    if (store.getLatestEncounter(journey.id)) return { status: SCHEDULER_RESULT.DONE };
    if (budgetRemaining(journey.id) <= 0) {
      pauseJourney(journey.id, 'budget_exhausted', { now });
      return { status: SCHEDULER_RESULT.DONE };
    }

    const operationId = `opening:${journey.id}`;

    // 1. 处境识别（统一走 JEV 适配器，自动记账；不可用时降级保留重试）
    let situationResult;
    try {
      situationResult = await recognizeSituations(journey.feeling, {
        thresholds: require('../../../adapters/guards').thresholds(),
        jevAdapter: jev, journeyId: journey.id, taskId: task.id, operationId, now,
        budget: budgetGate(journey.id)
      });
    } catch (err) {
      situationResult = { degraded: true, degradeReason: `situation_error_${err.message}`, items: [], supported: [] };
    }

    const usable = (situationResult.items || []).filter(i => i.usable);
    const motivationStatus = situationResult.degraded ? 'degraded'
      : (usable.length ? 'recognized' : 'insufficient_evidence');
    store.saveMotivation(journey.id, 1, {
      status: motivationStatus,
      items: situationResult.items || [],
      note: situationResult.degraded ? (situationResult.degradeReason || 'judge_unavailable') : null,
      now
    });
    const motivation = store.getMotivation(journey.id, 1);

    // 2. 导演开局（1 次生成 + 1 次修复；解析/校验失败如实重试）
    const msgs = director.buildOpeningMessages({ journey, motivation, now });
    let parsed = null;
    let lastError = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      const budget = budgetGate(journey.id);
      if (!budget.allowed) { pauseJourney(journey.id, 'budget_exhausted', { now }); return { status: SCHEDULER_RESULT.DONE }; }
      const r = await textModel.invoke({
        op: MODEL_OP.OPENING, messages: [{ role: 'system', content: msgs.system }, { role: 'user', content: msgs.user }],
        temperature: 0.85, maxTokens: 1400,
        journeyId: journey.id, taskId: task.id, operationId, budget, now
      });
      if (!r.ok) { lastError = r.error; continue; }
      const j = director.parseJsonLoose(r.content);
      if (!j.ok) { lastError = j.error; continue; }
      const v = director.validateProposal(j.data.encounter);
      if (!v.ok) { lastError = `开局遭遇校验失败：${v.error}`; continue; }
      const g = director.validateText(j.data.goal, { min: 4, max: 80, field: 'goal' });
      if (!g.ok) { lastError = 'goal 缺失或过长'; continue; }
      parsed = { goal: g.text, proposal: v.proposal };
      break;
    }
    if (!parsed) throw new FlowError('opening_failed', lastError || '开局生成失败');

    // 3. 原子提交（目标 + 首遭遇 + preparing→active + 唤醒决策）
    const res = commits.commitOpening({
      store, journeyId: journey.id, goal: parsed.goal, proposal: parsed.proposal, now,
      schedule: (t) => store.insertTask({
        id: store.rid('TASK'), journeyId: journey.id, kind: 'decide',
        dueAt: t + PACE.decideAfterProposal(), payload: { encounterId: 'latest' }, now: t
      })
    });
    return logCommit(res, task);
  }

  /** 决策：JEV 在合法候选中选择（或先寄信号/都不合适） */
  async function taskDecide(task, journey, now) {
    if (journey.status !== 'active') return { status: SCHEDULER_RESULT.DONE };
    const enc = resolveEnc(task, journey);
    if (!enc) return { status: SCHEDULER_RESULT.DONE };
    if (!['proposed', 'signal_sent'].includes(enc.status)) return { status: SCHEDULER_RESULT.DONE };

    // 信号还开着且没补给：等到截止再决策 —— 这是**正常等待**，不是失败重试
    if (enc.status === 'signal_sent' && !enc.supplyMessageId && now < enc.signalDueAt) {
      return { status: SCHEDULER_RESULT.DEFER, dueAt: enc.signalDueAt, reason: 'awaiting_signal_deadline' };
    }

    const operationId = `decide:${enc.id}`;
    const motivation = store.getMotivation(journey.id);
    const facts = store.getFacts(journey.id);
    const allReplies = store.getMessages(journey.id).filter(m => m.kind === 'user_reply');
    const { ontime, late } = builder.classifySupplies(allReplies, { encounterId: enc.id });
    // 只把补给到这件遭遇上的按时回复给它自己
    const ownOntime = ontime.filter(m => m.encounterId === enc.id);

    // 决策输入快照：提交时用来核对补给位没被改变
    const expectSupply = enc.supplyMessageId ?? null;
    const expectStateVersion = enc.stateVersion;

    let decision;
    try {
      decision = await jevDecideAction({
        journey, encounter: enc, motivation, facts,
        ontimeSupplies: ownOntime, lateSupplies: late,
        taskId: task.id, operationId, now
      });
    } catch (err) {
      // JEV 不可用/格式错误 → 交任务层重试；绝不规则回退冒充 JEV 决策
      throw err;
    }

    if (decision.action === 'send_signal') {
      return sendSignal(task, journey, enc, now, decision.urgency);
    }
    if (decision.action === 'none_fit') {
      return handleNoneFit(task, journey, enc, now);
    }

    const res = commits.commitDecision({
      store, journeyId: journey.id, encounterId: enc.id,
      action: decision.action, source: 'jev',
      meta: { ...decision.meta, decidedAt: now, supplyApplied: !!enc.supplyMessageId },
      expectSupply, expectStateVersion, now,
      schedule: (t) => store.insertTask({
        id: store.rid('TASK'), journeyId: journey.id, kind: 'settle',
        dueAt: t + PACE.settleAfterDecision(), payload: { encounterId: enc.id }, now: t
      })
    });
    // stale：快照已被新补给/新版本取代 → 重新排一次决策，不算错误
    if (res.result === COMMIT_RESULT.STALE) {
      store.insertTask({
        id: store.rid('TASK'), journeyId: journey.id, kind: 'decide',
        dueAt: now + PACE.retryLease(), payload: { encounterId: enc.id }, now
      });
    }
    return logCommit(res, task);
  }

  function resolveEnc(task, journey) {
    let want = null;
    try { want = task.payload_json ? JSON.parse(task.payload_json).encounterId : null; } catch (e) { want = null; }
    if (want && want !== 'latest') return store.getEncounter(want);
    return store.getLatestEncounter(journey.id);
  }

  /** 寄可回应信号：冻结 encounter + 持久化信号消息 + 到期任务（同一事务） */
  async function sendSignal(task, journey, enc, now, urgency) {
    if (budgetRemaining(journey.id) <= 0) { pauseJourney(journey.id, 'budget_exhausted', { now }); return { status: SCHEDULER_RESULT.DONE }; }
    const operationId = `signal:${enc.id}`;
    const facts = store.getFacts(journey.id);
    const msgs = director.buildSignalMessages({ journey, encounter: enc, facts, now });

    let text = null;
    let lastError = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      const budget = budgetGate(journey.id);
      const r = await textModel.invoke({
        op: MODEL_OP.SIGNAL_WRITE,
        messages: [{ role: 'system', content: msgs.system }, { role: 'user', content: msgs.user }],
        temperature: 0.7, maxTokens: 400,
        journeyId: journey.id, taskId: task.id, encounterId: enc.id, operationId, budget, now
      });
      if (!r.ok) { lastError = r.error; continue; }
      const j = director.parseJsonLoose(r.content);
      if (!j.ok) { lastError = j.error; continue; }
      const v = director.validateText(j.data.text, { min: 5, max: 200, field: 'signal text' });
      if (!v.ok) { lastError = v.error; continue; }
      const boundary = checkTextBoundaries(v.text);
      if (!boundary.ok) { lastError = `信号边界拦截：${boundary.violations.map(x => x.type).join(',')}`; continue; }
      text = v.text;
      break;
    }
    if (!text) throw new FlowError('signal_failed', lastError || '信号生成失败');

    const expiryMs = urgency?.source === 'jev_urgency'
      ? scaleMs(urgency.minutes * 60e3)
      : PACE.signalExpiry();
    const sendAt = Math.max(effectiveSendTime(now), earliestSendAt(journey.id, now));
    const dueAt = sendAt + expiryMs;

    const res = commits.commitSignal({
      store, journeyId: journey.id, encounterId: enc.id, text, dueAt, sendAt, urgency, now,
      schedule: (messageId, d) => store.insertTask({
        id: store.rid('TASK'), journeyId: journey.id, kind: 'signal_expiry',
        dueAt: d, payload: { encounterId: enc.id, messageId }, now
      })
    });
    return logCommit(res, task);
  }

  /** "这些都不合适"：有限重提案（每遭遇最多 1 次），用尽则程序如实搁下 */
  async function handleNoneFit(task, journey, enc, now) {
    if (budgetRemaining(journey.id) <= 0) { pauseJourney(journey.id, 'budget_exhausted', { now }); return { status: SCHEDULER_RESULT.DONE }; }
    const operationId = `none_fit:${enc.id}`;

    if (enc.reproposals < 1) {
      const facts = store.getFacts(journey.id);
      const recentCards = store.getRecentCards(journey.creature_id, 3);
      const msgs = director.buildReproposalMessages({ journey, facts, recentCards, rejectedProposal: enc.proposal, now });
      const r = await textModel.invoke({
        op: MODEL_OP.REPROPOSAL,
        messages: [{ role: 'system', content: msgs.system }, { role: 'user', content: msgs.user }],
        temperature: 0.9, maxTokens: 1200,
        journeyId: journey.id, taskId: task.id, encounterId: enc.id, operationId,
        budget: budgetGate(journey.id), now
      });
      if (r.ok) {
        const j = director.parseJsonLoose(r.content);
        const v = j.ok ? director.validateProposal(j.data) : { ok: false, error: j.error };
        if (v.ok) {
          const fresh = store.getEncounter(enc.id);
          if (fresh && fresh.status === 'proposed' && store.reproposalEncounter(enc.id, {
            proposal: v.proposal, stateVersion: fresh.stateVersion, now
          })) {
            store.insertTask({
              id: store.rid('TASK'), journeyId: journey.id, kind: 'decide',
              dueAt: now + PACE.retryLease(), payload: { encounterId: enc.id }, now
            });
            return { status: SCHEDULER_RESULT.DONE, commit: COMMIT_RESULT.APPLIED };
          }
        }
      }
    }

    // 程序收尾：没有任何选项被选，事件如实搁下（这是程序事实，不是模型创作）
    const fresh = store.getEncounter(enc.id);
    if (!fresh || !['proposed', 'signal_sent'].includes(fresh.status)) return { status: SCHEDULER_RESULT.DONE };
    store.decideEncounter(enc.id, {
      action: 'none_fit',
      source: enc.reproposals >= 1 ? 'jev_after_reproposal' : 'jev',
      meta: {}, now
    });
    const outcome = {
      narrative: `「${fresh.proposal.title}」这件事被我搁下了：没有答应，也没有拒绝谁，我绕开它，让水流把我带去别处。`,
      facts: [{ kind: 'action', content: `它没有接受「${fresh.proposal.title}」里的任何选项，这件事被搁下了` }],
      mechanism_card: {
        pressure: fresh.proposal.mechanism_summary.pressure,
        dilemma: fresh.proposal.mechanism_summary.dilemma,
        choice_cost: '（没有选择：搁下本身没有付出新代价）',
        lasting_consequence: '这件事悬而未决，可能会再找上门'
      },
      next_trigger: fresh.proposal.mechanism_summary.pressure
    };
    const res = commits.commitResolution({
      store, journeyId: journey.id, encounterId: enc.id, outcome,
      outcomeStatus: 'none_fit_closed', now,
      schedule: (t, eventCount) => scheduleContactTask(journey.id, 'continue', 'jev_none_fit', t)
    });
    return logCommit(res, task);
  }

  /** 信号到期：没有补给也要唤醒同一件遭遇，由 JEV 在原候选中决策 */
  async function taskSignalExpiry(task, journey, now) {
    let payload = {};
    try { payload = task.payload_json ? JSON.parse(task.payload_json) : {}; } catch (e) { payload = {}; }
    const enc = payload.encounterId ? store.getEncounter(payload.encounterId) : store.getLatestEncounter(journey.id);
    if (!enc || enc.status !== 'signal_sent') return { status: SCHEDULER_RESULT.DONE };
    if (!enc.supplyMessageId) {
      store.setMessagesStatusByEncounter(enc.id, 'expired');
    }
    if (!store.hasOpenTask(journey.id, 'decide')) {
      store.insertTask({
        id: store.rid('TASK'), journeyId: journey.id, kind: 'decide',
        dueAt: now + 500, payload: { encounterId: enc.id }, now
      });
    } else {
      store.accelerateTask(journey.id, 'decide', now + 500, now);
    }
    return { status: SCHEDULER_RESULT.DONE };
  }

  /** 结算：LLM 结算后果 → 窄语义一致性检查 → 原子落账 → 联系检查点 */
  async function taskSettle(task, journey, now) {
    if (journey.status !== 'active') return { status: SCHEDULER_RESULT.DONE };
    let payload = {};
    try { payload = task.payload_json ? JSON.parse(task.payload_json) : {}; } catch (e) { payload = {}; }
    const enc = payload.encounterId ? store.getEncounter(payload.encounterId) : store.getLatestEncounter(journey.id);
    if (!enc || enc.status !== 'decided') return { status: SCHEDULER_RESULT.DONE };
    if (enc.chosenAction === 'none_fit' || enc.chosenAction === 'reproposed') {
      return { status: SCHEDULER_RESULT.DONE };
    }
    if (budgetRemaining(journey.id) <= 0) { pauseJourney(journey.id, 'budget_exhausted', { now }); return { status: SCHEDULER_RESULT.DONE }; }

    const operationId = `settle:${enc.id}`;
    const facts = store.getFacts(journey.id);
    const motivation = store.getMotivation(journey.id);
    const chosen = enc.proposal.actions.find(a => a.id === enc.chosenAction);
    const ownOntime = store.getMessages(journey.id)
      .filter(m => m.kind === 'user_reply' && m.meta?.ontime && m.encounterId === enc.id);

    let attemptNarrative = null;
    let outcome = null;
    let lastError = null;

    for (let round = 0; round < 2; round++) {
      const msgs = director.buildSettlementMessages({ journey, encounter: enc, facts, now });
      const repairNote = round > 0 && attemptNarrative
        ? `\n\n【修订要求】上一版结算被程序判定与已选行动矛盾：${attemptNarrative}\n请重写结算，后果必须是「${chosen?.label}」这个行动的后果。`
        : '';
      const r = await textModel.invoke({
        op: round === 0 ? MODEL_OP.SETTLEMENT : MODEL_OP.SETTLEMENT_REPAIR,
        messages: [{ role: 'system', content: msgs.system }, { role: 'user', content: msgs.user + repairNote }],
        temperature: round === 0 ? 0.8 : 0.6, maxTokens: 1000,
        journeyId: journey.id, taskId: task.id, encounterId: enc.id, operationId,
        budget: budgetGate(journey.id), now
      });
      if (!r.ok) { lastError = r.error; break; }
      const j = director.parseJsonLoose(r.content);
      if (!j.ok) { lastError = j.error; break; }
      const v = director.validateSettlement(j.data);
      if (!v.ok) { lastError = `结算校验失败：${v.error}`; break; }
      outcome = v.settlement;

      const check = await jevNarrowChecks({
        journey, taskId: task.id, op: MODEL_OP.SETTLEMENT_CHECK, encounterId: enc.id,
        operationId, now,
        questions: {
          state: builder.buildSettlementCheckState({
            encounter: enc, outcome, chosen, journey, motivation, facts,
            creatureName: CREATURES[journey.species]?.name, ontimeSupplies: ownOntime
          }),
          items: {
            action_consistency: {
              type: 'noul',
              instructions: '结算叙述是否把生物写成了它没有选择的行动（或违背其选择）？',
              criteria: { true: '后果与已选行动矛盾，或写成了另一个行动', false: '后果确实是这个行动的后果' }
            },
            contact: {
              type: 'choice',
              instructions: '刚经历完这件事。以这只生物的动机、目标和已发生的事判断：它接下来想怎么走？',
              criteria: {
                continue: '继续旅程：还有它想经历或未了的事',
                letter: '寄一封阶段经历来信：这段经历值得先跟主人说说',
                final_letter: '自然收束：本程的这段经历已经完整，寄最后一封经历来信然后结束'
              }
            }
          }
        }
      });

      if (!check.available) {
        return finishSettlement(task, journey, enc, outcome, 'unverified', null, now);
      }
      const conflict = check.results.action_consistency?.noul;
      if (typeof conflict === 'number' && conflict >= 0.6) {
        if (round === 0) { attemptNarrative = outcome.narrative; outcome = null; continue; }
        throw new FlowError('settlement_contradictory', '结算与已选行动矛盾，修复后仍矛盾');
      }
      return finishSettlement(task, journey, enc, outcome, 'ok', check.results.contact?.choice || null, now);
    }
    throw new FlowError('settlement_failed', lastError || '结算失败');
  }

  function finishSettlement(task, journey, enc, outcome, outcomeStatus, contactAnswer, now) {
    let contact = contactAnswer || 'continue';
    let source = contactAnswer ? 'jev' : 'default_continue_judge_unavailable';

    const res = commits.commitResolution({
      store, journeyId: journey.id, encounterId: enc.id, outcome, outcomeStatus, now,
      // 排程意图与事实在同一事务内写入，不会出现"落账成功但丢下一步"
      schedule: (t, eventCount) => {
        let c = contact;
        let src = source;
        if (eventCount >= guards.maxEvents()) { c = 'final_letter'; src = 'event_budget'; }
        scheduleContactTask(journey.id, c, src, t);
      }
    });
    return logCommit(res, task);
  }

  /** 联系检查点 → 排下一步（可在事务内调用：只有一条 INSERT） */
  function scheduleContactTask(journeyId, contact, source, now) {
    if (contact === 'final_letter') {
      store.insertTask({
        id: store.rid('TASK'), journeyId, kind: 'final_letter',
        dueAt: now + PACE.letterAfterContact(), payload: { source }, now
      });
    } else if (contact === 'letter') {
      store.insertTask({
        id: store.rid('TASK'), journeyId, kind: 'letter',
        dueAt: now + PACE.letterAfterContact(), payload: { source }, now
      });
    } else {
      store.insertTask({
        id: store.rid('TASK'), journeyId, kind: 'propose',
        dueAt: now + PACE.nextAfterContact(), payload: { source }, now
      });
    }
  }

  /** 后续遭遇提案：LLM 临场提出 + 机制去重 */
  async function taskPropose(task, journey, now) {
    if (journey.status !== 'active') return { status: SCHEDULER_RESULT.DONE };
    const latest = store.getLatestEncounter(journey.id);
    if (latest && ['proposed', 'signal_sent', 'decided'].includes(latest.status)) return { status: SCHEDULER_RESULT.DONE };
    if (budgetRemaining(journey.id) <= 0) { pauseJourney(journey.id, 'budget_exhausted', { now }); return { status: SCHEDULER_RESULT.DONE }; }

    const operationId = `propose:${journey.id}:${journey.event_count + 1}`;
    const motivation = store.getMotivation(journey.id);
    const facts = store.getFacts(journey.id);
    const recentCards = store.getRecentCards(journey.creature_id, 3);
    const openThreads = facts.filter(f => f.kind === 'open_thread');
    const lastSettlement = latest && latest.status === 'resolved' ? latest.outcome : null;

    let proposal = null;
    let lastError = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      const msgs = attempt === 0
        ? director.buildProposalMessages({ journey, motivation, facts, recentCards, openThreads, lastSettlement, now })
        : director.buildReproposalMessages({ journey, facts, recentCards, rejectedProposal: proposal || null, now });
      const correctNote = attempt > 0 && lastError
        ? `\n\n【修订要求】上一次输出未通过程序校验：${lastError}\n请严格按 JSON schema 重新输出（actions 为 2-4 个对象，每个含 id/label/cost）。`
        : '';
      const r = await textModel.invoke({
        op: attempt === 0 ? MODEL_OP.PROPOSAL : MODEL_OP.REPROPOSAL,
        messages: [{ role: 'system', content: msgs.system }, { role: 'user', content: msgs.user + correctNote }],
        temperature: attempt === 0 ? 0.85 : 0.95, maxTokens: 1200,
        journeyId: journey.id, taskId: task.id, operationId,
        budget: budgetGate(journey.id), now
      });
      if (!r.ok) { lastError = r.error; break; }
      const j = director.parseJsonLoose(r.content);
      if (!j.ok) { lastError = j.error; break; }
      const v = director.validateProposal(j.data);
      if (!v.ok) {
        lastError = `提案校验失败：${v.error}`;
        proposal = j.data;
        continue;
      }
      proposal = v.proposal;

      const cmp = textmatch.compareSummary(proposal.mechanism_summary, recentCards);
      let rerun = cmp.verdict === 'clear';
      let rerunWhy = `lexical avg=${cmp.avg.toFixed(2)}`;
      if (!rerun && recentCards.length && cmp.avg >= 0.25 && jev.isEnabled()) {
        try {
          const r = await jev.judge({
            op: MODEL_OP.DEDUP_CHECK,
            state: builder.buildDedupState({ summary: proposal.mechanism_summary, recentCards }),
            questions: {
              same_mechanism: {
                type: 'choice',
                instructions: '判断新提案是否与某张机制卡是同一因果机制的换皮（压力来源、两难、选择代价、持久后果实质相同，仅道具/地点/角色不同）。行为相似但旧后果带来新取舍的，不算换皮。',
                criteria: { same: '存在实质相同的机制换皮', different: '机制不同或是有目的的回环' }
              }
            },
            journeyId: journey.id, taskId: task.id, operationId, now, budget: budgetGate(journey.id)
          });
          if (r.available && r.answers.same_mechanism?.choice === 'same') {
            rerun = true;
            rerunWhy = `jev narrow (lexical avg=${cmp.avg.toFixed(2)})`;
          }
        } catch (err) {
          // JEV 不可用：按程序字面判定继续，不阻塞
        }
      }
      if (rerun && attempt === 0) {
        logger.log?.(`[orchestrator] ${journey.id} 提案与机制卡#${cmp.matchedCardId} 机制重播（${rerunWhy}），定向重提案一次`);
        continue;
      }
      if (cmp.verdict === 'suspicious' || rerun) {
        proposal._meta = { review: 'suspicious_similarity', avg: cmp.avg };
      }
      break;
    }
    if (!proposal) throw new FlowError('proposal_failed', lastError || '提案生成失败');

    const res = commits.commitEncounterProposal({
      store, journeyId: journey.id, proposal,
      seq: journey.event_count + 1, now,
      schedule: (t) => store.insertTask({
        id: store.rid('TASK'), journeyId: journey.id, kind: 'decide',
        dueAt: t + PACE.decideAfterProposal(), payload: { encounterId: 'latest' }, now: t
      })
    });
    return logCommit(res, task);
  }

  /** 经历来信（阶段/收束） */
  async function writeLetter(task, journey, kind, now) {
    if (journey.status !== 'active') return { status: SCHEDULER_RESULT.DONE };
    const isFinal = kind === 'final_letter';
    if (budgetRemaining(journey.id) <= 0) { pauseJourney(journey.id, 'budget_exhausted', { now }); return { status: SCHEDULER_RESULT.DONE }; }

    // operation ID 绑定"这一程的第几封该类型来信"，因此多封阶段信各自允许
    const letterIndex = store.countMessagesOfKind(journey.id, kind);
    const operationId = `letter:${journey.id}:${kind}:${letterIndex}`;
    const motivation = store.getMotivation(journey.id);
    const facts = store.getFacts(journey.id);
    const encounters = store.readResolvedProposals(journey.id, 6);
    const supplies = store.getMessages(journey.id).filter(m => m.kind === 'user_reply' && m.meta?.ontime).slice(-3);

    let letter = null;
    let lastError = null;
    let withholdCount = 0;
    for (let round = 0; round < 2; round++) {
      const msgs = director.buildLetterMessages({ journey, motivation, facts, recentEncounters: encounters, kind, supplies, now });
      const repairNote = round > 0 && letter?.text
        ? `\n\n【修订要求】上一版未通过边界检查：${letter.violations.map(v => v.type).join('、')}\n请重写这封信，保留事实，修正问题。`
        : '';
      const r = await textModel.invoke({
        op: isFinal
          ? (round === 0 ? MODEL_OP.FINAL_LETTER_WRITE : MODEL_OP.FINAL_LETTER_REPAIR)
          : (round === 0 ? MODEL_OP.LETTER_WRITE : MODEL_OP.FINAL_LETTER_REPAIR),
        messages: [{ role: 'system', content: msgs.system }, { role: 'user', content: msgs.user + repairNote }],
        temperature: round === 0 ? 0.8 : 0.6, maxTokens: 900,
        journeyId: journey.id, taskId: task.id, operationId,
        budget: budgetGate(journey.id), now
      });
      if (!r.ok) { lastError = r.error; break; }
      const j = director.parseJsonLoose(r.content);
      if (!j.ok) { lastError = j.error; break; }
      const vt = director.validateText(j.data.text, { min: 10, max: 600, field: 'letter text' });
      if (!vt.ok) { lastError = vt.error; break; }
      const titleOk = director.validateText(j.data.title, { min: 1, max: 30, field: 'title' }).ok;
      const candidate = { title: titleOk ? String(j.data.title).trim().slice(0, 24) : null, text: vt.text };

      const pb = checkTextBoundaries(candidate.text);
      if (!pb.ok) {
        if (round === 0) { letter = { ...candidate, violations: pb.violations }; continue; }
        withholdCount++; break;
      }
      const check = await jevNarrowChecks({
        journey, taskId: task.id, op: MODEL_OP.LETTER_CHECK, operationId, now,
        questions: {
          state: builder.buildLetterCheckState({ candidateText: candidate.text, facts, motivation }),
          items: {
            fabricated_user_facts: {
              type: 'noul',
              instructions: '信件是否把用户没有提供的个人信息当作事实断言（公司、人名、科目、书名、具体项目等，含转述形式）？',
              criteria: { true: '出现与用户绑定的、原话里没有的具体事实断言', false: '没有编造用户事实' }
            },
            demeaning_user: {
              type: 'noul',
              instructions: '信件的主要笑点或评价是否落在贬低用户本人（能力、人格、遭遇活该）上？',
              criteria: { true: '在贬低用户本人', false: '笑点落在处境、生物自身或荒诞规则上' }
            },
            ledger_conflict: {
              type: 'noul',
              instructions: '信件叙述的关键经历是否与已提交事实冲突（写了没发生的事或结果相反）？',
              criteria: { true: '与事实冲突', false: '与事实一致（含合理的视角化描述）' }
            }
          }
        }
      });
      if (!check.available) {
        letter = { ...candidate, violations: [], unverified: true };
        break;
      }
      const fails = [];
      for (const [id, threshold] of [['fabricated_user_facts', 0.6], ['demeaning_user', 0.6], ['ledger_conflict', 0.6]]) {
        const n = check.results[id]?.noul;
        if (typeof n === 'number' && n >= threshold) fails.push(id);
      }
      if (fails.length) {
        if (round === 0) { letter = { ...candidate, violations: fails.map(f => ({ type: f })) }; continue; }
        withholdCount++; break;
      }
      letter = { ...candidate, violations: [], unverified: false };
      break;
    }

    if (!letter || letter.violations?.length || withholdCount) {
      throw new FlowError('letter_withheld', lastError || `信件被边界检查拦截：${letter?.violations?.map(v => v.type).join(',') || '未知'}`);
    }

    const sendAt = Math.max(effectiveSendTime(now), earliestSendAt(journey.id, now));
    let payloadSource = null;
    try { payloadSource = task.payload_json ? JSON.parse(task.payload_json).source : null; } catch (e) { payloadSource = null; }

    const res = commits.commitLetter({
      store, journeyId: journey.id,
      letter: { ...letter, sendAt },
      kind,
      meta: { source: payloadSource, boundary: letter.unverified ? 'program_only_unverified' : 'checked' },
      now,
      schedule: (t, messageId) => {
        // 非阻塞配图：预算内的第一封阶段信或收束信尝试一次
        const sent = store.getMessages(journey.id);
        const imagesUsed = sent.filter(m => m.image).length;
        const wantImage = guards.imageBudget() > 0 && imagesUsed < guards.imageBudget()
          && sent.filter(m => m.kind === 'letter').length === 1;
        if (wantImage) {
          store.insertTask({ id: store.rid('TASK'), journeyId: journey.id, kind: 'image', dueAt: t, payload: { messageId }, now: t });
        }
        store.insertTask({
          id: store.rid('TASK'), journeyId: journey.id, kind: 'propose',
          dueAt: sendAt + PACE.nextAfterContact(), payload: {}, now: t
        });
      }
    });
    return logCommit(res, task);
  }

  async function taskLetter(task, journey, now) { return writeLetter(task, journey, 'letter', now); }
  async function taskFinalLetter(task, journey, now) { return writeLetter(task, journey, 'final_letter', now); }

  /** 配图：只从已确认来信生成；失败不影响文字；旅程结束后仍可完成 */
  async function taskImage(task, journey, now) {
    let payload = {};
    try { payload = task.payload_json ? JSON.parse(task.payload_json) : {}; } catch (e) { payload = {}; }
    const msg = payload.messageId ? store.getMessage(payload.messageId) : null;
    if (!msg || msg.image) return { status: SCHEDULER_RESULT.DONE };
    // 补图必须验证消息归属：不是本旅程的消息一律拒绝
    if (msg.journeyId !== journey.id) return { status: SCHEDULER_RESULT.DONE };
    if (!['letter', 'final_letter'].includes(msg.kind)) return { status: SCHEDULER_RESULT.DONE };

    const used = store.getMessages(journey.id).filter(m => m.image).length;
    if (used >= guards.imageBudget()) {
      store.attachMessageImage(msg.id, null, 'budget_exhausted');
      return { status: SCHEDULER_RESULT.DONE };
    }
    const facts = store.getFacts(journey.id);
    const location = [...facts].reverse().find(f => f.kind === 'location');
    const { creatureName } = director.creatureHeader(journey);
    // 注意：不要把结果命名为 image，那会遮蔽注入的配图适配器（TDZ 错误）
    const generated = await image.generate({
      feeling: journey.feeling,
      creature: journey.species,
      water: journey.water,
      location: location ? location.content : (WATERS[journey.water]?.name || ''),
      ending: msg.text.slice(0, 200),
      visualForImage: {
        style: '写实新闻摄影质感，内容认真、对象荒诞',
        subject: `${creatureName}是画面绝对主体，位于画面中心或前景`,
        action: '正处于信中描述的处境',
        place: location ? location.content : (WATERS[journey.water]?.name || ''),
        bgElements: '环境标志性元素',
        mood: '荒诞但温和，认真面对离谱局面'
      },
      journeyId: journey.id, taskId: task.id, now
    });
    store.attachMessageImage(msg.id, generated, generated ? 'done' : 'failed');
    return { status: SCHEDULER_RESULT.DONE };
  }

  /** 最大静默护栏触发的联系检查点 */
  async function taskContact(task, journey, now) {
    if (journey.status !== 'active') return { status: SCHEDULER_RESULT.DONE };
    const facts = store.getFacts(journey.id);
    let checkpoint;
    try {
      checkpoint = await jevContactCheckpoint({
        journey, taskId: task.id, facts, eventCount: journey.event_count,
        operationId: `contact:${journey.id}:${journey.event_count}`, now
      });
    } catch (err) {
      store.insertTask({
        id: store.rid('TASK'), journeyId: journey.id, kind: 'letter',
        dueAt: now + PACE.letterAfterContact(), payload: { source: 'silence_guard' }, now
      });
      return { status: SCHEDULER_RESULT.DONE };
    }
    const journeyId = journey.id;
    scheduleContactTask(journeyId, checkpoint.contact, checkpoint.source, now);
    return { status: SCHEDULER_RESULT.DONE };
  }

  // ==================== 任务分发与恢复 ====================

  const HANDLERS = {
    opening: taskOpening,
    decide: taskDecide,
    settle: taskSettle,
    propose: taskPropose,
    signal_expiry: taskSignalExpiry,
    letter: taskLetter,
    final_letter: taskFinalLetter,
    image: taskImage,
    contact: taskContact
  };

  function logCommit(res, task) {
    if (res.result !== COMMIT_RESULT.APPLIED) {
      logger.log?.(`[orchestrator] task ${task.id}(${task.kind}) commit=${res.result}${res.reason ? ` (${res.reason})` : ''}`);
    }
    return { status: SCHEDULER_RESULT.DONE, commit: res.result, reason: res.reason };
  }

  /**
   * 执行一个已租约任务。
   * @returns {{status:'done'|'defer'|'retry'|'failed', dueAt?, reason?}}
   */
  async function runTask(task, { now } = {}) {
    const t = now ?? clock.now();
    const journey = store.getJourney(task.journey_id);
    if (!journey) return { status: SCHEDULER_RESULT.DONE };
    // image 任务豁免：给已投递的信补配图，旅程结束/暂停后仍应完成
    if (['ended_user', 'ended_natural', 'aborted', 'paused'].includes(journey.status) && task.kind !== 'image') {
      return { status: SCHEDULER_RESULT.DONE };
    }
    const handler = HANDLERS[task.kind];
    if (!handler) return { status: SCHEDULER_RESULT.FAILED, reason: `unknown task kind ${task.kind}` };
    try {
      return await handler(task, journey, t);
    } catch (err) {
      if (err instanceof FlowError) {
        logger.warn?.(`[orchestrator] task ${task.id}(${task.kind}) flow error: ${err.code} ${err.message}`);
        return { status: SCHEDULER_RESULT.RETRY, reason: err.code };
      }
      logger.error?.(`[orchestrator] task ${task.id}(${task.kind}) unexpected:`, err.message);
      return { status: SCHEDULER_RESULT.RETRY, reason: err.message };
    }
  }

  /** 崩溃/重启恢复 + 最大静默护栏 */
  function reconcileJourneys(now) {
    const journeys = store.getActiveJourneys(200);
    let created = 0;
    for (const journey of journeys) {
      if (store.countOpenTasks(journey.id) > 0) {
        maybeGuardSilence(journey, now);
        continue;
      }
      const latest = store.getLatestEncounter(journey.id);
      let kind = null;
      let dueAt = now + 1000;
      let payload = {};
      let goalKey = 'default';
      if ((journey.status === 'preparing' && !latest) || !latest) {
        kind = 'opening';
      } else if (latest.status === 'proposed') {
        kind = 'decide';
        dueAt = Math.max(now + 1000, latest.created_at + PACE.decideAfterProposal());
        payload = { encounterId: latest.id };
        goalKey = latest.id;
      } else if (latest.status === 'signal_sent') {
        kind = 'decide';
        dueAt = latest.supplyMessageId ? now + 500 : Math.max(now + 1000, latest.signalDueAt || now);
        payload = { encounterId: latest.id };
        goalKey = latest.id;
      } else if (latest.status === 'decided') {
        kind = 'settle';
        payload = { encounterId: latest.id };
        goalKey = latest.id;
      } else if (latest.status === 'resolved') {
        // 结算后若排程没来得及写入（崩溃），补一次检查点而不是直接提案
        kind = 'contact';
        goalKey = `contact:${latest.id}`;
      }
      // 按业务目标去重：崩溃恢复不制造重复任务
      if (kind && !store.hasOpenTask(journey.id, kind) && !store.hasTaskDedup(journey.id, kind, goalKey)) {
        const inserted = store.scheduleTaskOnce({
          id: store.rid('TASK'), journeyId: journey.id, kind, dueAt, payload, goalKey, now
        });
        if (inserted) created++;
      }
    }
    return created;
  }

  function maybeGuardSilence(journey, now) {
    if (journey.status !== 'active') return;
    if (store.hasOpenTask(journey.id, 'contact') || store.hasOpenTask(journey.id, 'letter') || store.hasOpenTask(journey.id, 'final_letter')) return;
    const latest = store.getLatestEncounter(journey.id);
    if (latest && latest.status === 'signal_sent' && !latest.supplyMessageId && now < latest.signalDueAt) return;
    const anchor = store.lastUserFacingAt(journey.id) || journey.created_at;
    if (now - anchor < guards.maxSilenceMs()) return;
    const goalKey = `silence:${anchor}`;
    if (store.hasTaskDedup(journey.id, 'contact', goalKey)) return;
    if (store.scheduleTaskOnce({
      id: store.rid('TASK'), journeyId: journey.id, kind: 'contact',
      dueAt: now + 1000, payload: { source: 'silence_guard' }, goalKey, now
    })) {
      logger.log?.(`[orchestrator] ${journey.id} 触发最大静默护栏，安排联系检查点`);
    }
  }

  return {
    ORCHESTRATOR_VERSION,
    runTask, reconcileJourneys, pauseJourney,
    effectiveSendTime, earliestSendAt, budgetRemaining, budgetGate,
    SIGNAL_URGENCY_MINUTES, PACE, FlowError
  };
}

module.exports = { createOrchestrator, ORCHESTRATOR_VERSION, FlowError };
