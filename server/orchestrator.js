// 赛博放生 · 旅程编排核心（v2）—— 单生物自主文字旅程
//
// 分工纪律（handoff §3）：
// - LLM 是文字世界导演：临场提出遭遇、结算后果、写信号/来信；不能替 JEV 选行动，
//   不能在后果里写成它做了别的事，模型文字必须经程序校验后由程序落账
// - JEV 是行动决策脑：每次决策都收到本程动机档案（原文+证据+不确定性）、生物目标、
//   已发生事实、合法候选和按时到达的用户补给；JEV 不可用就重试/暂停，绝不规则冒充
// - 程序掌握权威事实：状态版本乐观锁 + 条件更新 + 事务内原子落账；模型调用在事务外；
//   已公开/已提交的事有稳定 ID，失败、重试、刷新都不能改写
// - 读取 API 不触发任何模型生成；页面在线与否不影响推进
// - 所有入口（HTTP、调度器、验证脚本）共用本模块的生产函数

const db = require('./db');
const clock = require('./clock');
const { guards, scaleMs } = require('./flags');
const { thresholds } = require('./flags');
const jev = require('./jev');
const director = require('./director');
const { recognizeSituations } = require('./situations');
const { CREATURES, WATERS } = require('./data');
const textmatch = require('./textmatch');
const { checkTextBoundaries } = require('./boundary');

const ORCHESTRATOR_VERSION = 'journey-orchestrator-v2';

// 服务节奏（可经 J_TIME_SCALE 缩放；是服务护栏，不是剧情拍板）
// 信号截止的紧急度分桶：JEV 在选择寄信号的同一请求里选桶，程序映射为分钟（1-120 区间）
const SIGNAL_URGENCY_MINUTES = {
  instant: 3,    // 千钧一发
  urgent: 10,    // 很急
  soon: 30,      // 有些急
  unhurried: 60, // 不算急
  patient: 120   // 可以慢慢等
};

const PACE = {
  decideAfterProposal: () => scaleMs(3 * 60e3),   // 提案冻结后 JEV 何时决策
  settleAfterDecision: () => scaleMs(2 * 60e3),   // 选定行动后何时结算
  signalExpiry: () => guards.signalDeadlineMs(),   // 信号补给截止
  nextAfterContact: () => scaleMs(15 * 60e3),     // 联系检查点后下一遭遇
  letterAfterContact: () => scaleMs(2 * 60e3),    // 检查点决定写信后何时写
  retryLease: () => scaleMs(30e3)
};

class FlowError extends Error {
  // 可预期失败：由任务层转为重试/暂停；message 面向日志
  constructor(code, message) { super(message || code); this.code = code; }
}

// ==================== 服务护栏 ====================

// 安静时段：本地时间 [start, end) 内不寄信，顺延到 quietEnd
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

// 最小发送间隔：与上一封用户面向消息的间隔护栏
function earliestSendAt(journeyId, now) {
  const last = db.lastUserFacingAt(journeyId);
  const min = guards.minIntervalMs();
  if (!last || !min) return now;
  return Math.max(now, last + min);
}

function budgetRemaining(journeyId) {
  return guards.maxModelCalls() - db.countModelCalls(journeyId);
}

// 预算用尽 → 旅程如实暂停（不是生物自主收束）
function pauseJourney(journeyId, reason, { notice, now } = {}) {
  const t = now ?? clock.now();
  const journey = db.getJourney(journeyId);
  if (!journey) return false;
  const ok = db.updateJourney(journeyId, {
    status: 'paused', pause_reason: reason
  }, { status: journey.status });
  if (!ok) return false;
  db.cancelTasksForJourney(journeyId, t);
  db.insertMessage({
    id: db.rid('MSG'), journeyId, kind: 'system', encounterId: null,
    text: notice || `服务提示：旅程已暂停（${reason}）。这不是${CREATURES[journey.species]?.name || '生物'}的来信；恢复或结束后可再次出发。`,
    status: 'sent', sentAt: t, now: t
  });
  return true;
}

// ==================== 用户操作（HTTP 直接调用；读取类不触模型） ====================

/**
 * 放生/建程：先持久化，立即返回 preparing 回执；
 * 开局由后台 opening 任务完成，首个模型调用不阻塞可见成功状态。
 */
function startJourney({ ownerKey, creatureId, species, water, feeling, tone }) {
  if (!guards.journeyEnabled()) return { ok: false, code: 'journey_disabled' };
  if (!CREATURES[species]) return { ok: false, code: 'invalid_species' };
  if (!WATERS[water]) return { ok: false, code: 'invalid_water' };
  const text = String(feeling || '').trim();
  if (!text) return { ok: false, code: 'empty_feeling' };
  if (text.length > 500) return { ok: false, code: 'feeling_too_long' };
  const effTone = guards.toneValid(tone) ? tone : 'balanced';

  const now = clock.now();
  let creature = null;
  if (creatureId) {
    creature = db.getOwnedCreature(creatureId, ownerKey);
    if (!creature) return { ok: false, code: 'creature_not_found' };
    if (creature.species !== species) return { ok: false, code: 'species_mismatch' };
  } else {
    creature = db.createCreature({ id: db.rid('CRT'), ownerKey, species, now });
  }

  const journey = db.createJourney({
    id: db.rid('JRN'), creatureId: creature.id, ownerKey,
    species: creature.species, water, feeling: text, tone: effTone, now
  });
  db.insertTask({ id: db.rid('TASK'), journeyId: journey.id, kind: 'opening', dueAt: now, payload: {}, now });
  return { ok: true, journey, creature };
}

/**
 * 回应信号：按时 → 进入这件尚未提交的 JEV 决策；
 * 迟到 → 只作为本程之后未决行动的参考，不改写已发生的选择。
 */
function replyToSignal({ ownerKey, journeyId, text }) {
  const journey = db.getOwnedJourney(journeyId, ownerKey);
  if (!journey) return { ok: false, code: 'journey_not_found' };
  const now = clock.now();
  if (['ended_user', 'ended_natural', 'aborted'].includes(journey.status)) {
    return { ok: false, code: 'journey_ended', message: '本程已结束，留言不会被带进下一程' };
  }
  const clean = String(text || '').trim().slice(0, 120);
  if (!clean) return { ok: false, code: 'empty_reply' };

  // 找到这件还挂在信号上的未决遭遇（必须是最新遭遇，避免旧信号复活）
  const latest = db.getLatestEncounter(journeyId);
  const enc = latest && latest.status === 'signal_sent' ? latest : null;

  if (enc && now <= enc.signalDueAt) {
    const msgId = db.rid('MSG');
    const applied = db.attachSupply(enc.id, msgId, now);
    if (applied) {
      db.insertMessage({
        id: msgId, journeyId, kind: 'user_reply', encounterId: enc.id,
        text: clean, status: 'sent', meta: { ontime: true }, sentAt: now, now
      });
      // 立即唤醒这件遭遇的决策（补给是决策证据，不是命令）
      db.insertTask({ id: db.rid('TASK'), journeyId, kind: 'decide', dueAt: now, payload: { encounterId: enc.id }, now });
      db.accelerateTask(journeyId, 'decide', now, now);
      return { ok: true, ontime: true };
    }
    // 另一条并发回复已抢到补给位：这条按迟到参考记录
  }
  db.insertMessage({
    id: db.rid('MSG'), journeyId, kind: 'user_reply',
    encounterId: enc ? enc.id : null,
    text: clean, status: 'late',
    meta: { late: true, reason: enc ? 'signal_expired' : 'no_pending_signal' }, sentAt: now, now
  });
  return { ok: true, ontime: false, message: '这条回复来晚了：不会改写已发生的选择，只作为它之后面对未决之事时的参考' };
}

/** 语气偏好：只影响未来遭遇的荒诞程度与文风，不改 JEV 决策、不改已承诺事实与旧来信 */
function setTone({ ownerKey, journeyId, tone }) {
  const journey = db.getOwnedJourney(journeyId, ownerKey);
  if (!journey) return { ok: false, code: 'journey_not_found' };
  if (!guards.toneValid(tone)) return { ok: false, code: 'invalid_tone' };
  const now = clock.now();
  const applied = db.updateJourney(journeyId, { tone }, { status: journey.status });
  return { ok: applied, tone };
}

/** 用户主动结束：立即生效，不等模型写漂亮结尾；新事件停止排程 */
function endJourney({ ownerKey, journeyId }) {
  const journey = db.getOwnedJourney(journeyId, ownerKey);
  if (!journey) return { ok: false, code: 'journey_not_found' };
  const now = clock.now();
  const applied = db.endJourneyByUser(journeyId, now);
  if (!applied) return { ok: false, code: 'already_ended' };
  db.cancelTasksForJourney(journeyId, now);
  db.insertMessage({
    id: db.rid('MSG'), journeyId, kind: 'system',
    text: '服务提示：你已结束这段旅程。已收到的信还在信箱里；这只生物随时可以再次出发。',
    status: 'sent', sentAt: now, now
  });
  return { ok: true };
}

// ==================== 读取视图（绝不触模型） ====================

function journeyPhase(journey, latestEnc, now) {
  if (journey.status === 'preparing') return 'preparing';
  if (journey.status === 'paused') return 'paused';
  if (['ended_user', 'ended_natural', 'aborted'].includes(journey.status)) return 'ended';
  if (!latestEnc) return 'journeying';
  if (latestEnc.status === 'signal_sent') return 'awaiting_reply';
  if (latestEnc.status === 'proposed') return 'journeying';       // 隐藏遭遇内容
  if (latestEnc.status === 'decided') return 'experiencing';
  return 'journeying';
}

function publicMessageView(m, now) {
  return {
    id: m.id, kind: m.kind, title: m.title, text: m.text,
    image: m.image, imageStatus: m.imageStatus, status: m.status,
    sentAt: m.sentAt, meta: {
      isFinal: m.kind === 'final_letter',
      ontime: m.meta?.ontime ?? null, late: m.meta?.late ?? null
    }
  };
}

function getJourneyView({ ownerKey, journeyId }) {
  const journey = db.getOwnedJourney(journeyId, ownerKey);
  if (!journey) return null;
  const now = clock.now();
  const latestEnc = db.getLatestEncounter(journeyId);
  const motivation = db.getMotivation(journeyId);
  const allMessages = db.getMessages(journeyId).filter(m => m.sentAt <= now);
  const facts = db.getFacts(journeyId);

  // 待回应信号：只公开这一件已寄出（sent_at 已到）信号的未决遭遇
  let pendingSignal = null;
  if (latestEnc && latestEnc.status === 'signal_sent') {
    const sigMsg = latestEnc.signalMessageId ? db.getMessage(latestEnc.signalMessageId) : null;
    if (sigMsg && sigMsg.sentAt <= now) {
      pendingSignal = {
        encounterId: latestEnc.id,
        messageId: latestEnc.signalMessageId,
        text: sigMsg.text,
        sentAt: sigMsg.sentAt,
        dueAt: latestEnc.signalDueAt,
        remainingMs: Math.max(0, latestEnc.signalDueAt - now),
        replied: !!latestEnc.supplyMessageId,
        actions: latestEnc.proposal.actions.map(a => ({ id: a.id, label: a.label, cost: a.cost }))
      };
    }
  }

  let experiencing = null;
  if (latestEnc && latestEnc.status === 'decided') {
    const chosen = latestEnc.proposal.actions.find(a => a.id === latestEnc.chosenAction);
    experiencing = {
      encounterId: latestEnc.id, title: latestEnc.proposal.title,
      chosenAction: chosen ? chosen.label : latestEnc.chosenAction,
      stage: 'settling'
    };
  }

  const lastResolved = db.getDb().prepare(`
    SELECT * FROM encounters WHERE journey_id = ? AND status = 'resolved' ORDER BY seq DESC LIMIT 1
  `).get(journeyId);

  return {
    id: journey.id,
    creatureId: journey.creature_id,
    creatureName: CREATURES[journey.species]?.name || journey.species,
    creatureEmoji: CREATURES[journey.species]?.emoji || '🐚',
    species: journey.species,
    water: journey.water,
    waterName: WATERS[journey.water]?.name || journey.water,
    status: journey.status,
    phase: journeyPhase(journey, latestEnc, now),
    pauseReason: journey.pause_reason || null,
    tone: journey.tone,
    goal: journey.status === 'preparing' ? null : (journey.goal || null),
    motivation: motivation ? {
      version: motivation.version,
      status: motivation.status,
      rawText: motivation.rawText,
      items: (motivation.items || []).filter(i => i.usable).map(i => ({ id: i.id, label: i.label, evidence: i.evidenceText }))
    } : null,
    pendingSignal,
    experiencing,
    lastResolved: lastResolved ? { id: lastResolved.id, title: JSON.parse(lastResolved.proposal_json).title } : null,
    messages: allMessages.map(m => publicMessageView(m, now)),
    eventCount: journey.event_count,
    factsCount: facts.length,
    createdAt: journey.created_at,
    serverTime: now
  };
}

function listJourneys(ownerKey) {
  const now = clock.now();
  return db.getJourneysByOwner(ownerKey).map(j => {
    const msgs = db.getMessages(j.id).filter(m => m.sentAt <= now && ['signal', 'letter', 'final_letter'].includes(m.kind));
    const last = msgs[msgs.length - 1];
    return {
      id: j.id, creatureId: j.creature_id, species: j.species,
      creatureName: CREATURES[j.species]?.name || j.species,
      creatureEmoji: CREATURES[j.species]?.emoji || '🐚',
      water: j.water, waterName: WATERS[j.water]?.name || j.water,
      status: j.status, phase: journeyPhase(j, db.getLatestEncounter(j.id), now),
      tone: j.tone, eventCount: j.event_count,
      lastMessageAt: last ? last.sentAt : null,
      lastMessageTitle: last ? (last.title || null) : null,
      createdAt: j.created_at
    };
  });
}

function listCreatures(ownerKey) {
  const now = clock.now();
  return db.getCreaturesByOwner(ownerKey).map(c => {
    const journeys = db.getDb().prepare(
      `SELECT id, status, created_at FROM journeys WHERE creature_id = ? ORDER BY created_at DESC`
    ).all(c.id);
    const active = journeys.find(j => ['preparing', 'active', 'paused'].includes(j.status));
    return {
      id: c.id, species: c.species,
      creatureName: CREATURES[c.species]?.name || c.species,
      creatureEmoji: CREATURES[c.species]?.emoji || '🐚',
      journeyCount: journeys.length,
      hasActiveJourney: !!active,
      activeJourneyId: active ? active.id : null,
      createdAt: c.created_at
    };
  });
}

// ==================== JEV 调用封装（真实来源；不可用即重试/暂停） ====================

function motivationForJev(motivation) {
  if (!motivation) return '（档案缺失）';
  if (motivation.status === 'pending') return '（识别尚未完成）';
  if (motivation.status === 'degraded') return `（识别不可用：${motivation.note || '仅原话可用'}）`;
  const usable = (motivation.items || []).filter(i => i.usable);
  if (!usable.length) return `（证据不足，未确认稳定处境。原话：「${motivation.rawText}」）`;
  return {
    版本: motivation.version,
    原话: motivation.rawText,
    被支持的处境: usable.map(i => ({ 处境: i.label, 证据: i.evidenceText, 置信: i.confidence })),
    说明: '这些是本程动机证据；用户留言是决策证据，不是覆盖动机的命令'
  };
}

// 每次行动决策的完整输入（handoff §3.1）
function buildDecisionState({ journey, encounter, motivation, facts, supplies }) {
  return JSON.stringify({
    生物: CREATURES[journey.species]?.name || journey.species,
    自身目标: journey.goal || '（未设定）',
    本程动机档案: motivationForJev(motivation),
    已发生的相关事实: facts.slice(-14).map(f => `[${f.kind}] ${f.content}`),
    当前遭遇: {
      标题: encounter.proposal.title,
      处境: encounter.proposal.situation,
      约束: encounter.proposal.constraints,
      候选动作: encounter.proposal.actions.map(a => ({ id: a.id, 行动: a.label, 代价: a.cost })),
      机制摘要: encounter.proposal.mechanism_summary
    },
    用户补给: supplies.length
      ? supplies.map(m => ({ 原话: m.text, 按时: !!m.meta?.ontime, 说明: '这是证据与态度，不是命令；一次许可不等于此后永远如此' }))
      : '（无）'
  }, null, 1);
}

async function jevDecideAction({ journey, encounter, motivation, facts, supplies, taskId, now }) {
  if (!jev.isJeVEnabled()) throw new FlowError('jev_unavailable', 'JEV 未配置');
  const criteria = {};
  for (const a of encounter.proposal.actions) criteria[a.id] = `${a.label}（代价：${a.cost}）`;
  criteria.none_fit = '这些都不合适：现有选项都违背它的处境、目标或安全（触发有限重提案）';
  if (encounter.status === 'proposed') {
    criteria.send_signal = '先不行动：就这件未决处境给主人寄一个可回应的信号，等回复或到期后再决定';
  }
  // 紧急度（独立问题）：只在它选择寄信号时被程序采用；时间窗由程序映射持有
  const urgencyCriteria = {
    instant: '千钧一发：它马上就要面对结果，主人几分钟内回一句才算来得及',
    urgent: '很急：事情就在眼前，大约十分钟内会变',
    soon: '有些急：再拖一阵就要变了',
    unhurried: '不算急：值得等主人一会儿，但不该占它一整天',
    patient: '不急：它愿意慢慢等主人想清楚'
  };
  const state = buildDecisionState({ journey, encounter, motivation, facts, supplies });
  try {
    const r = await jev.jevJudge(state, {
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
    });
    director.recordJeVCall({ journeyId: journey.id, taskId, kind: 'jev_decide', result: r, now });
    const choice = r.answers.action.choice;
    if (!criteria[choice]) throw new FlowError('jev_format', `JEV 返回了非法选项 ${choice}`);
    const urgencyLevel = r.answers.signal_urgency?.choice;
    const urgency = SIGNAL_URGENCY_MINUTES[urgencyLevel]
      ? { source: 'jev_urgency', level: urgencyLevel, minutes: SIGNAL_URGENCY_MINUTES[urgencyLevel] }
      : { source: 'fallback_default', level: null, minutes: null };
    return { action: choice, urgency, meta: { usage: r.usage, model: r.model, latencyMs: r.latencyMs, urgency } };
  } catch (err) {
    if (!(err instanceof FlowError)) {
      director.recordJeVCall({ journeyId: journey.id, taskId, kind: 'jev_decide', error: err, now });
    }
    throw err;
  }
}

// 联系检查点：继续 / 阶段来信 / 自然收束（与结算一致性检查同请求，问题彼此独立）
async function jevContactCheckpoint({ journey, taskId, facts, eventCount, now, extraQuestions }) {
  const criteria = {
    continue: '继续旅程：还有它想经历或未了的事',
    letter: '寄一封阶段经历来信：这段经历值得先跟主人说说',
    final_letter: '自然收束：本程的这段经历已经完整，寄最后一封经历来信然后结束'
  };
  if (eventCount >= guards.maxEvents()) return { contact: 'final_letter', source: 'event_budget' };
  if (!jev.isJeVEnabled()) return { contact: 'continue', source: 'default_continue_judge_unavailable' };
  const questions = {
    ...(extraQuestions || {}),
    contact: {
      type: 'choice',
      instructions: '刚经历完一件事。以这只生物的动机、目标和已发生的事判断：它接下来想怎么走？',
      criteria
    }
  };
  const r = await jev.jevJudge(JSON.stringify({
    生物: CREATURES[journey.species]?.name || journey.species,
    自身目标: journey.goal || '',
    本程动机: motivationForJev(db.getMotivation(journey.id)),
    已发生事实: facts.slice(-12).map(f => f.content)
  }), questions);
  director.recordJeVCall({ journeyId: journey.id, taskId, kind: 'jev_contact', result: r, now });
  const contact = r.answers.contact?.choice;
  if (!criteria[contact]) throw new FlowError('jev_format', 'contact 非法选项');
  return { contact, source: 'jev' };
}

// 窄语义边界检查（一次请求，独立 noul 问题；用于信件与结算的一致性拦截）
async function jevNarrowChecks({ journey, taskId, kind, questions, now }) {
  if (!jev.isJeVEnabled()) return { available: false, results: null };
  const r = await jev.jevJudge(JSON.stringify(questions.state), questions.items);
  director.recordJeVCall({ journeyId: journey.id, taskId, kind, result: r, now });
  return { available: true, results: r.answers };
}

// ==================== 旅程回顾时间线（只读） ====================
//
// 披露边界：只在旅程结束后开放——进行中全量公开遭遇会取消"生物自己选择
// 何时来信"的意义（handoff §3.3）。结束后所有信已寄出，展开无副作用。
// 纯读取：不触发任何模型调用；单程回顾，不是跨旅程故事档案（第二阶段）。

const ENDED_STATUSES = ['ended_user', 'ended_natural', 'aborted'];

function getJourneyTimeline({ ownerKey, journeyId }) {
  const journey = db.getOwnedJourney(journeyId, ownerKey);
  if (!journey) return { ok: false, code: 'journey_not_found' };
  if (!ENDED_STATUSES.includes(journey.status)) {
    return { ok: false, code: 'journey_not_finished', message: '旅程还在进行中：它想自己决定什么时候讲给你听。这一程结束后，这里会展开完整时间线。' };
  }
  const now = clock.now();
  const encounters = db.getEncounters(journeyId);
  const messages = db.getMessages(journeyId).filter(m => m.sentAt <= now);
  const motivation = db.getMotivation(journeyId);
  const header = director.creatureHeader(journey);

  const nodes = [];
  nodes.push({
    kind: 'opening',
    at: encounters.length ? encounters[0].createdAt : journey.created_at,
    goal: journey.goal || null,
    creatureName: header.creatureName,
    creatureEmoji: CREATURES[journey.species]?.emoji || '🐚',
    waterName: header.waterName,
    motivation: motivation ? {
      status: motivation.status,
      rawText: motivation.rawText,
      items: (motivation.items || []).filter(i => i.usable).map(i => i.label)
    } : null
  });

  for (const enc of encounters) {
    const actions = enc.proposal?.actions || [];
    const chosen = actions.find(a => a.id === enc.chosenAction) || null;
    nodes.push({
      kind: 'encounter',
      at: enc.updatedAt,
      seq: enc.seq,
      title: enc.proposal?.title || `第 ${enc.seq} 站`,
      situation: enc.proposal?.situation || null,
      options: actions.map(a => ({ label: a.label, cost: a.cost })),
      chosenAction: chosen ? chosen.label : (enc.chosenAction === 'none_fit' ? '（都不合适，搁下了）' : enc.chosenAction),
      chosenCost: chosen ? chosen.cost : null,
      decisionSource: enc.decisionSource,
      narrative: enc.outcome?.narrative || null,
      outcomeFacts: (enc.outcome?.facts || []).map(f => f.content),
      settled: enc.status === 'resolved',
      unresolvedNote: enc.status !== 'resolved' ? '这件事还没落定，旅程就先停在了这里。' : null,
      hadSignal: !!enc.signalMessageId
    });
  }

  for (const m of messages) {
    nodes.push({
      kind: m.kind, // signal | letter | final_letter | user_reply | system
      at: m.sentAt,
      title: m.title || null,
      text: m.text,
      image: m.image || null,
      imageStatus: m.imageStatus || null,
      status: m.status,
      late: !!m.meta?.late,
      isFinal: m.kind === 'final_letter'
    });
  }

  nodes.sort((a, b) => a.at - b.at);
  const reasonText = journey.ending_reason === 'user' ? '你结束了这段旅程' : '这一程自然收束';
  nodes.push({ kind: 'ending', at: Math.max(journey.updated_at || 0, ...nodes.map(n => n.at)), reason: journey.ending_reason, reasonText, status: journey.status });

  return { ok: true, timeline: { journeyId, status: journey.status, nodes } };
}

// ==================== 任务处理器（幂等；状态迁移条件化） ====================

// --- 开局：识别处境 → 建动机档案 → 导演给目标+首遭遇 → 冻结 ---
async function taskOpening(task, journey, now) {
  if (journey.status !== 'preparing') return { status: 'done' };
  if (db.getLatestEncounter(journey.id)) return { status: 'done' }; // 已开局（幂等）
  if (budgetRemaining(journey.id) <= 0) {
    pauseJourney(journey.id, 'budget_exhausted', { now });
    return { status: 'done' };
  }

  // 1. 处境识别（内部自带降级；识别不可用时保留待重试，不用伪造档案决策）
  let situationResult = null;
  try {
    situationResult = await recognizeSituations(journey.feeling, { thresholds: thresholds() });
  } catch (err) {
    situationResult = { degraded: true, degradeReason: `situation_error_${err.message}`, items: [], supported: [] };
  }
  const usable = (situationResult.items || []).filter(i => i.usable);
  const motivationStatus = situationResult.degraded ? 'degraded'
    : usable.length ? 'recognized' : 'insufficient_evidence';
  db.saveMotivation(journey.id, 1, {
    status: motivationStatus,
    items: situationResult.items || [],
    note: situationResult.degraded ? (situationResult.degradeReason || 'judge_unavailable') : null,
    now
  });
  const motivation = db.getMotivation(journey.id, 1);

  // 2. 导演开局（1 次生成 + 1 次修复预算；解析/校验失败如实重试）
  const msgs = director.buildOpeningMessages({ journey, motivation, now });
  let parsed = null;
  let lastError = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (budgetRemaining(journey.id) <= 0) { pauseJourney(journey.id, 'budget_exhausted', { now }); return { status: 'done' }; }
    const r = await director.callLLM({ journeyId: journey.id, taskId: task.id, kind: 'director_opening', system: msgs.system, user: msgs.user, temperature: 0.85, maxTokens: 1400, now });
    if (!r.ok) { lastError = r.error; continue; }
    const j = director.parseJsonLoose(r.content);
    if (!j.ok) { lastError = j.error; continue; }
    const v = director.validateProposal(j.data.encounter);
    if (!v.ok) { lastError = `开局遭遇校验失败：${v.error}`; continue; }
    if (!director.validateText(j.data.goal, { min: 4, max: 80, field: 'goal' }).ok) { lastError = 'goal 缺失或过长'; continue; }
    parsed = { goal: director.validateText(j.data.goal, { min: 4, max: 80, field: 'goal' }).text, proposal: v.proposal };
    break;
  }
  if (!parsed) throw new FlowError('opening_failed', lastError || '开局生成失败');

  // 3. 原子提交：目标 + 首遭遇提案 + preparing→active（状态版本推进）
  const fresh = db.getJourney(journey.id);
  if (!fresh || fresh.status !== 'preparing' || db.getLatestEncounter(journey.id)) return { status: 'done' };
  const tx = db.getDb().transaction(() => {
    const okJ = db.updateJourney(journey.id, {
      status: 'active', goal: parsed.goal, state_version: fresh.state_version + 1
    }, { status: 'preparing', state_version: fresh.state_version });
    if (!okJ) throw new FlowError('state_conflict', '开局提交状态冲突');
    db.insertEncounter({
      id: db.rid('ENC'), journeyId: journey.id, seq: 1,
      proposal: parsed.proposal, factsVersion: fresh.state_version,
      stateVersion: fresh.state_version + 1, now
    });
  });
  try { tx(); } catch (err) {
    if (err instanceof FlowError) return { status: 'done' }; // 并发已开局
    throw err;
  }
  db.insertTask({ id: db.rid('TASK'), journeyId: journey.id, kind: 'decide', dueAt: now + PACE.decideAfterProposal(), payload: { encounterId: 'latest' }, now });
  return { status: 'done' };
}

// --- 决策：JEV 在合法候选中选择（或先寄信号/都不合适） ---
async function taskDecide(task, journey, now) {
  if (journey.status !== 'active') return { status: 'done' };
  const enc = resolveEnc(task, journey, now);
  if (!enc) return { status: 'done' };
  if (!['proposed', 'signal_sent'].includes(enc.status)) return { status: 'done' };
  // 信号还开着且没补给：等到截止再决策（页面不在线不影响；到期任务也会唤醒）
  if (enc.status === 'signal_sent' && !enc.supplyMessageId && now < enc.signalDueAt) {
    return { status: 'retry', dueAt: enc.signalDueAt };
  }

  const motivation = db.getMotivation(journey.id);
  const facts = db.getFacts(journey.id);
  const supplies = enc.supplyMessageId
    ? [db.getMessage(enc.supplyMessageId)].filter(Boolean)
    : [];

  let decision;
  try {
    decision = await jevDecideAction({ journey, encounter: enc, motivation, facts, supplies, taskId: task.id, now });
  } catch (err) {
    if (err instanceof FlowError && err.code === 'jev_format') throw err; // 格式错误值得重试一次
    throw err; // 网络等错误 → 任务层重试/退避；绝不规则回退冒充 JEV
  }

  if (decision.action === 'send_signal') {
    return sendSignal(task, journey, enc, now, decision.urgency);
  }
  if (decision.action === 'none_fit') {
    return handleNoneFit(task, journey, enc, now);
  }
  // 真实 JEV 行动选择：条件提交（一次性；迟到回复/并发不得改写）
  const ok = db.decideEncounter(enc.id, {
    action: decision.action, source: 'jev',
    meta: { ...decision.meta, decidedAt: now, supplyApplied: !!enc.supplyMessageId }, now
  });
  if (!ok) return { status: 'done' }; // 状态已被并发推进
  db.insertTask({ id: db.rid('TASK'), journeyId: journey.id, kind: 'settle', dueAt: now + PACE.settleAfterDecision(), payload: { encounterId: enc.id }, now });
  return { status: 'done' };
}

function resolveEnc(task, journey, now) {
  const want = task.payload_json ? JSON.parse(task.payload_json).encounterId : null;
  if (want && want !== 'latest') return db.getEncounter(want);
  return db.getLatestEncounter(journey.id);
}

// --- 寄可回应信号：冻结 encounter + 持久化 pending_signal + 到期任务 ---
async function sendSignal(task, journey, enc, now, urgency) {
  if (budgetRemaining(journey.id) <= 0) { pauseJourney(journey.id, 'budget_exhausted', { now }); return { status: 'done' }; }
  const facts = db.getFacts(journey.id);
  const msgs = director.buildSignalMessages({ journey, encounter: enc, facts, now });
  let text = null;
  let lastError = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await director.callLLM({ journeyId: journey.id, taskId: task.id, kind: 'signal_write', system: msgs.system, user: msgs.user, temperature: 0.7, maxTokens: 400, now });
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

  // 冻结 + 持久化（原子：信号消息与 encounter 冻结必须同时成立）
  // 截止时长：JEV 紧急度桶映射（1-120 分钟）；无效/缺失 → 默认回退，来源如实记录
  const expiryMs = urgency?.source === 'jev_urgency'
    ? scaleMs(urgency.minutes * 60e3)
    : PACE.signalExpiry();
  const msgId = db.rid('MSG');
  const sendAt = Math.max(effectiveSendTime(now), earliestSendAt(journey.id, now));
  const dueAt = sendAt + expiryMs;
  const fresh = db.getEncounter(enc.id);
  if (!fresh || fresh.status !== 'proposed') return { status: 'done' };
  const tx = db.getDb().transaction(() => {
    const okF = db.freezeEncounterSignal(enc.id, { messageId: msgId, dueAt, now });
    if (!okF) throw new FlowError('state_conflict', '信号冻结冲突');
    db.insertMessage({
      id: msgId, journeyId: journey.id, kind: 'signal', encounterId: enc.id,
      text, status: 'sent', sentAt: sendAt, now,
      meta: { dueAt, encounterTitle: enc.proposal.title, deadlineSource: urgency?.source || 'fallback_default', urgencyLevel: urgency?.level || null, urgencyMinutes: urgency?.minutes || null }
    });
  });
  try { tx(); } catch (err) {
    if (err instanceof FlowError) return { status: 'done' };
    throw err;
  }
  db.insertTask({ id: db.rid('TASK'), journeyId: journey.id, kind: 'signal_expiry', dueAt, payload: { encounterId: enc.id }, now });
  return { status: 'done' };
}

// --- “这些都不合适”：有限重提案（每遭遇最多 1 次），用尽则程序如实搁下 ---
async function handleNoneFit(task, journey, enc, now) {
  if (budgetRemaining(journey.id) <= 0) { pauseJourney(journey.id, 'budget_exhausted', { now }); return { status: 'done' }; }
  if (enc.reproposals < 1) {
    const facts = db.getFacts(journey.id);
    const recentCards = db.getRecentCards(journey.creature_id, 3);
    const msgs = director.buildReproposalMessages({ journey, facts, recentCards, rejectedProposal: enc.proposal, now });
    const r = await director.callLLM({ journeyId: journey.id, taskId: task.id, kind: 'director_reproposal', system: msgs.system, user: msgs.user, temperature: 0.9, maxTokens: 1200, now });
    if (r.ok) {
      const j = director.parseJsonLoose(r.content);
      const v = j.ok ? director.validateProposal(j.data) : { ok: false, error: j.error };
      if (v.ok) {
        const fresh = db.getEncounter(enc.id);
        if (fresh && fresh.status === 'proposed' && db.reproposalEncounter(enc.id, { proposal: v.proposal, stateVersion: fresh.stateVersion, now })) {
          // 遭遇保持 proposed：新候选仍由 JEV 决策（reproposals 已 +1，封顶）
          db.insertTask({ id: db.rid('TASK'), journeyId: journey.id, kind: 'decide', dueAt: now + PACE.retryLease(), payload: { encounterId: enc.id }, now });
          return { status: 'done' };
        }
      }
    }
    // 重提案失败：落到“如实搁下”，不再无限重写
  }
  // 程序收尾：没有任何选项被选，事件如实搁下（这是程序事实，不是模型创作）
  const fresh = db.getEncounter(enc.id);
  if (!fresh || !['proposed', 'signal_sent'].includes(fresh.status)) return { status: 'done' };
  db.decideEncounter(enc.id, { action: 'none_fit', source: enc.reproposals >= 1 ? 'jev_after_reproposal' : 'jev', meta: {}, now });
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
  return commitResolution({ journey, encounter: fresh, outcome, outcomeStatus: 'none_fit_closed', taskId: task.id, now });
}

// --- 信号到期：没有补给也要唤醒同一件遭遇，由 JEV 在原候选中决策 ---
async function taskSignalExpiry(task, journey, now) {
  const payload = task.payload_json ? JSON.parse(task.payload_json) : {};
  const enc = payload.encounterId ? db.getEncounter(payload.encounterId) : db.getLatestEncounter(journey.id);
  if (!enc || enc.status !== 'signal_sent') return { status: 'done' };
  if (!enc.supplyMessageId) {
    // 未回复：信号标记过期（如实显示），但遭遇不消失
    db.setMessagesStatusByEncounter(enc.id, 'expired');
  }
  if (!db.hasOpenTask(journey.id, 'decide')) {
    db.insertTask({ id: db.rid('TASK'), journeyId: journey.id, kind: 'decide', dueAt: now + 500, payload: { encounterId: enc.id }, now });
  } else {
    db.accelerateTask(journey.id, 'decide', now + 500, now);
  }
  return { status: 'done' };
}

// --- 结算：LLM 结算后果 → 窄语义一致性检查 → 原子落账 → 联系检查点 ---
async function taskSettle(task, journey, now) {
  if (journey.status !== 'active') return { status: 'done' };
  const payload = task.payload_json ? JSON.parse(task.payload_json) : {};
  const enc = payload.encounterId ? db.getEncounter(payload.encounterId) : db.getLatestEncounter(journey.id);
  if (!enc || enc.status !== 'decided') return { status: 'done' };

  // 程序收尾的“搁下”不需要模型结算
  if (enc.chosenAction === 'none_fit' || enc.chosenAction === 'reproposed') {
    // 已在 handleNoneFit 提交；此处兜底（防御重复进入）
    return { status: 'done' };
  }
  if (budgetRemaining(journey.id) <= 0) { pauseJourney(journey.id, 'budget_exhausted', { now }); return { status: 'done' }; }

  const facts = db.getFacts(journey.id);
  const motivation = db.getMotivation(journey.id);
  const chosen = enc.proposal.actions.find(a => a.id === enc.chosenAction);
  let attemptNarrative = null;
  let outcome = null;
  let lastError = null;

  for (let round = 0; round < 2; round++) {
    const msgs = director.buildSettlementMessages({ journey, encounter: enc, facts, now });
    const repairNote = round > 0 && attemptNarrative
      ? `\n\n【修订要求】上一版结算被程序判定与已选行动矛盾：${attemptNarrative}\n请重写结算，后果必须是「${chosen?.label}」这个行动的后果。`
      : '';
    const r = await director.callLLM({
      journeyId: journey.id, taskId: task.id, kind: round === 0 ? 'director_settlement' : 'director_settlement_repair',
      system: msgs.system, user: msgs.user + repairNote, temperature: round === 0 ? 0.8 : 0.6, maxTokens: 1000, now
    });
    if (!r.ok) { lastError = r.error; break; }
    const j = director.parseJsonLoose(r.content);
    if (!j.ok) { lastError = j.error; break; }
    const v = director.validateSettlement(j.data);
    if (!v.ok) { lastError = `结算校验失败：${v.error}`; break; }
    outcome = v.settlement;

    // 窄语义检查：行动/后果矛盾 + 联系检查点（同请求、彼此独立的问题）
    const check = await jevNarrowChecks({
      journey, taskId: task.id, kind: 'jev_settlement_check', now,
      questions: {
        state: {
          遭遇: enc.proposal.situation,
          候选动作: enc.proposal.actions.map(a => ({ id: a.id, 行动: a.label })),
          生物实际选择: chosen ? chosen.label : enc.chosenAction,
          结算叙述: outcome.narrative,
          生物目标: journey.goal || '',
          本程动机档案: motivationForJev(motivation),
          已发生事实: facts.slice(-10).map(f => f.content)
        },
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
      return commitResolution({ journey, encounter: enc, outcome, outcomeStatus: 'unverified', taskId: task.id, now, contactAnswer: null });
    }
    const conflict = check.results.action_consistency?.noul;
    if (typeof conflict === 'number' && conflict >= 0.6) {
      if (round === 0) { attemptNarrative = outcome.narrative; outcome = null; continue; }
      throw new FlowError('settlement_contradictory', '结算与已选行动矛盾，修复后仍矛盾');
    }
    return commitResolution({ journey, encounter: enc, outcome, outcomeStatus: 'ok', taskId: task.id, now, contactAnswer: check.results.contact?.choice || null });
  }
  throw new FlowError('settlement_failed', lastError || '结算失败');
}

// 原子落账：encounter resolved + facts + 机制卡 + 旅程版本推进，然后排下一步
function commitResolution({ journey, encounter, outcome, outcomeStatus, taskId, now, contactAnswer }) {
  const fresh = db.getJourney(journey.id);
  const freshEnc = db.getEncounter(encounter.id);
  if (!fresh || !freshEnc || freshEnc.status !== 'decided') return { status: 'done' };
  const nextVersion = fresh.state_version + 1;
  const tx = db.getDb().transaction(() => {
    const okR = db.resolveEncounter(encounter.id, { outcome, outcomeStatus, stateVersion: nextVersion, now });
    if (!okR) throw new FlowError('state_conflict', '结算提交冲突');
    db.insertFacts(journey.id, encounter.id, encounter.seq, outcome.facts, now);
    db.insertMechanismCard({
      creatureId: journey.creature_id, journeyId: journey.id, encounterId: encounter.id,
      card: outcome.mechanism_card, now
    });
    const okJ = db.updateJourney(journey.id, {
      event_count: fresh.event_count + 1, state_version: nextVersion
    }, { state_version: fresh.state_version });
    if (!okJ) throw new FlowError('state_conflict', '旅程版本冲突');
  });
  try { tx(); } catch (err) {
    if (err instanceof FlowError) return { status: 'done' };
    throw err;
  }

  // 联系检查点（结算一致性请求中顺带拿到；无 JEV 时按 continue 走，来源如实记录）
  let contact = contactAnswer || 'continue';
  let contactSource = contactAnswer ? 'jev' : 'default_continue_judge_unavailable';
  if (fresh.event_count + 1 >= guards.maxEvents()) { contact = 'final_letter'; contactSource = 'event_budget'; }
  scheduleAfterContact(journey.id, contact, { now, source: contactSource });
  return { status: 'done' };
}

function scheduleAfterContact(journeyId, contact, { now, source }) {
  if (contact === 'final_letter') {
    db.insertTask({ id: db.rid('TASK'), journeyId, kind: 'final_letter', dueAt: now + PACE.letterAfterContact(), payload: { source }, now });
  } else if (contact === 'letter') {
    db.insertTask({ id: db.rid('TASK'), journeyId, kind: 'letter', dueAt: now + PACE.letterAfterContact(), payload: { source }, now });
  } else {
    db.insertTask({ id: db.rid('TASK'), journeyId, kind: 'propose', dueAt: now + PACE.nextAfterContact(), payload: { source }, now });
  }
}

// --- 后续遭遇提案：LLM 临场提出 + 机制去重（明显换皮最多一次定向重提案） ---
async function taskPropose(task, journey, now) {
  if (journey.status !== 'active') return { status: 'done' };
  const latest = db.getLatestEncounter(journey.id);
  if (latest && ['proposed', 'signal_sent', 'decided'].includes(latest.status)) return { status: 'done' };
  if (budgetRemaining(journey.id) <= 0) { pauseJourney(journey.id, 'budget_exhausted', { now }); return { status: 'done' }; }

  const motivation = db.getMotivation(journey.id);
  const facts = db.getFacts(journey.id);
  const recentCards = db.getRecentCards(journey.creature_id, 3);
  const openThreads = facts.filter(f => f.kind === 'open_thread');
  const lastSettlement = latest && latest.status === 'resolved' ? latest.outcome : null;

  let proposal = null;
  let lastError = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const msgs = attempt === 0
      ? director.buildProposalMessages({ journey, motivation, facts, recentCards, openThreads, lastSettlement, now })
      : director.buildReproposalMessages({ journey, facts, recentCards, rejectedProposal: proposal || null, now });
    const correctNote = attempt > 0 && lastError ? `\n\n【修订要求】上一次输出未通过程序校验：${lastError}\n请严格按 JSON schema 重新输出（actions 为 2-4 个对象，每个含 id/label/cost）。` : '';
    const r = await director.callLLM({ journeyId: journey.id, taskId: task.id, kind: attempt === 0 ? 'director_proposal' : 'director_dedup_reproposal', system: msgs.system, user: msgs.user + correctNote, temperature: attempt === 0 ? 0.85 : 0.95, maxTokens: 1200, now });
    if (!r.ok) { lastError = r.error; break; }
    const j = director.parseJsonLoose(r.content);
    if (!j.ok) { lastError = j.error; break; }
    const v = director.validateProposal(j.data);
    if (!v.ok) {
      lastError = `提案校验失败：${v.error}`;
      proposal = j.data; // 保留原始输出供修订引用
      continue;
    }
    proposal = v.proposal;
    // 机制去重：只对“未公开、未提交”的提案；明显换皮 → 最多一次定向重提案。
    // 程序字面比较优先；边界带（有词面重叠但不确定）允许一次 JEV 窄语义比较（有限候选，不做全库终审）。
    const cmp = textmatch.compareSummary(proposal.mechanism_summary, recentCards);
    let rerun = cmp.verdict === 'clear';
    let rerunWhy = `lexical avg=${cmp.avg.toFixed(2)}`;
    if (!rerun && recentCards.length && cmp.avg >= 0.25 && jev.isJeVEnabled()) {
      try {
        const r = await jev.jevJudge(JSON.stringify({
          新提案机制: proposal.mechanism_summary,
          最近机制卡: recentCards.map(c => ({ pressure: c.pressure, dilemma: c.dilemma, choice_cost: c.choice_cost, lasting_consequence: c.lasting_consequence }))
        }), {
          same_mechanism: {
            type: 'choice',
            instructions: '判断新提案是否与某张机制卡是同一因果机制的换皮（压力来源、两难、选择代价、持久后果实质相同，仅道具/地点/角色不同）。行为相似但旧后果带来新取舍的，不算换皮。',
            criteria: { same: '存在实质相同的机制换皮', different: '机制不同或是有目的的回环' }
          }
        });
        director.recordJeVCall({ journeyId: journey.id, taskId: task.id, kind: 'jev_dedup_check', result: r, now });
        if (r.answers.same_mechanism?.choice === 'same') {
          rerun = true;
          rerunWhy = `jev narrow (lexical avg=${cmp.avg.toFixed(2)})`;
        }
      } catch (err) {
        director.recordJeVCall({ journeyId: journey.id, taskId: task.id, kind: 'jev_dedup_check', error: err, now });
        // JEV 不可用：按程序字面判定继续，不阻塞
      }
    }
    if (rerun && attempt === 0) {
      console.log(`[orchestrator] ${journey.id} 提案与机制卡#${cmp.matchedCardId} 机制重播（${rerunWhy}），定向重提案一次`);
      continue;
    }
    if (cmp.verdict === 'suspicious' || rerun) {
      console.log(`[orchestrator] ${journey.id} 提案相似度可疑（avg=${cmp.avg.toFixed(2)}，卡#${cmp.matchedCardId}），记入抽样评审，不拦截`);
      proposal._meta = { review: 'suspicious_similarity', avg: cmp.avg };
    }
    break;
  }
  if (!proposal) throw new FlowError('proposal_failed', lastError || '提案生成失败');

  const fresh = db.getJourney(journey.id);
  if (!fresh || fresh.status !== 'active') return { status: 'done' };
  db.insertEncounter({
    id: db.rid('ENC'), journeyId: journey.id, seq: fresh.event_count + 1,
    proposal, factsVersion: fresh.state_version, stateVersion: fresh.state_version, now
  });
  db.insertTask({ id: db.rid('TASK'), journeyId: journey.id, kind: 'decide', dueAt: now + PACE.decideAfterProposal(), payload: { encounterId: 'latest' }, now });
  return { status: 'done' };
}

// --- 经历来信（阶段/收束）：只能叙述已提交事实；程序+窄语义边界检查 ---
async function writeLetter(task, journey, kind, now) {
  if (journey.status !== 'active') return { status: 'done' };
  const isFinal = kind === 'final_letter';
  if (budgetRemaining(journey.id) <= 0) { pauseJourney(journey.id, 'budget_exhausted', { now }); return { status: 'done' }; }

  const motivation = db.getMotivation(journey.id);
  const facts = db.getFacts(journey.id);
  const encounters = db.getDb().prepare(
    `SELECT proposal_json FROM encounters WHERE journey_id = ? AND status = 'resolved' ORDER BY seq DESC LIMIT 6`
  ).all(journey.id).map(r => ({ proposal: JSON.parse(r.proposal_json) }));
  const supplies = db.getMessages(journey.id).filter(m => m.kind === 'user_reply' && m.meta?.ontime).slice(-3);

  let letter = null;
  let lastError = null;
  let withholdCount = 0;
  for (let round = 0; round < 2; round++) {
    const msgs = director.buildLetterMessages({ journey, motivation, facts, recentEncounters: encounters, kind, supplies, now });
    const repairNote = round > 0 && letter?.text
      ? `\n\n【修订要求】上一版未通过边界检查：${letter.violations.map(v => v.type).join('、')}\n请重写这封信，保留事实，修正问题。`
      : '';
    const r = await director.callLLM({
      journeyId: journey.id, taskId: task.id, kind: isFinal ? (round === 0 ? 'final_letter_write' : 'final_letter_repair') : (round === 0 ? 'letter_write' : 'letter_repair'),
      system: msgs.system, user: msgs.user + repairNote, temperature: round === 0 ? 0.8 : 0.6, maxTokens: 900, now
    });
    if (!r.ok) { lastError = r.error; break; }
    const j = director.parseJsonLoose(r.content);
    if (!j.ok) { lastError = j.error; break; }
    const vt = director.validateText(j.data.text, { min: 10, max: 600, field: 'letter text' });
    if (!vt.ok) { lastError = vt.error; break; }
    const candidate = { title: director.validateText(j.data.title, { min: 1, max: 30, field: 'title' }).ok ? String(j.data.title).trim().slice(0, 24) : null, text: vt.text };

    // 1) 程序边界（字面：施压/贬低）
    const pb = checkTextBoundaries(candidate.text);
    if (!pb.ok) {
      if (round === 0) { letter = { ...candidate, violations: pb.violations }; continue; }
      withholdCount++; break;
    }
    // 2) 窄语义（JEV：编造用户事实 / 贬低 / 与账本冲突）；不可用 → 如实标记后放行（重试后仍不可用）
    const check = await jevNarrowChecks({
      journey, taskId: task.id, kind: 'jev_letter_check', now,
      questions: {
        state: {
          信件正文: candidate.text,
          已提交事实: facts.slice(-14).map(f => f.content),
          用户原话: motivation ? motivation.rawText : ''
        },
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
      // JEV 不可用：重试路径耗尽后由任务层决定；此轮先按 unverified 放行并如实标记
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
    // 拦截：不公开这版内容；如实降级（预算内重试由任务层处理）
    throw new FlowError('letter_withheld', lastError || `信件被边界检查拦截：${letter?.violations?.map(v => v.type).join(',') || '未知'}`);
  }

  // 提交：sent_at 尊重安静时段与最小间隔；用户看不到未来时间戳的信
  const msgId = db.rid('MSG');
  const sendAt = Math.max(effectiveSendTime(now), earliestSendAt(journey.id, now));
  db.insertMessage({
    id: msgId, journeyId: journey.id, kind: isFinal ? 'final_letter' : 'letter',
    text: letter.text, title: letter.title, status: 'sent', sentAt: sendAt, now,
    meta: { source: task.payload_json ? JSON.parse(task.payload_json).source : null, boundary: letter.unverified ? 'program_only_unverified' : 'checked' }
  });

  // 非阻塞配图：预算内的第一封阶段信或收束信尝试一次（失败不影响读信）
  const sent = db.getMessages(journey.id);
  const imagesUsed = sent.filter(m => m.image).length;
  const wantImage = guards.imageBudget() > 0 && imagesUsed < guards.imageBudget()
    && (isFinal || sent.filter(m => m.kind === 'letter').length === 1);
  if (wantImage) {
    db.insertTask({ id: db.rid('TASK'), journeyId: journey.id, kind: 'image', dueAt: now, payload: { messageId: msgId }, now });
  }

  if (isFinal) {
    const fresh = db.getJourney(journey.id);
    if (fresh) {
      db.updateJourney(journey.id, { status: 'ended_natural', ending_reason: 'natural' }, { status: fresh.status });
      db.cancelTasksForJourney(journey.id, now);
    }
  } else {
    // 阶段来信后继续旅程
    db.insertTask({ id: db.rid('TASK'), journeyId: journey.id, kind: 'propose', dueAt: sendAt + PACE.nextAfterContact(), payload: {}, now });
  }
  return { status: 'done' };
}

async function taskLetter(task, journey, now) {
  return writeLetter(task, journey, 'letter', now);
}

async function taskFinalLetter(task, journey, now) {
  return writeLetter(task, journey, 'final_letter', now);
}

// --- 配图：只从已确认来信与画面事实生成；失败不影响文字 ---
async function taskImage(task, journey, now) {
  const payload = task.payload_json ? JSON.parse(task.payload_json) : {};
  const msg = payload.messageId ? db.getMessage(payload.messageId) : null;
  if (!msg || msg.image) return { status: 'done' };
  const used = db.getMessages(journey.id).filter(m => m.image).length;
  if (used >= guards.imageBudget()) {
    db.attachMessageImage(msg.id, null, 'budget_exhausted');
    return { status: 'done' };
  }
  const facts = db.getFacts(journey.id);
  const location = [...facts].reverse().find(f => f.kind === 'location');
  const { creatureName } = director.creatureHeader(journey);
  try {
    const image = await require('./ai').generateReplyImage({
      feeling: journey.feeling, creature: journey.species, water: journey.water,
      destinySummary: {
        location: location ? location.content : (WATERS[journey.water]?.name || ''),
        ending: msg.text.slice(0, 200),
        visualForImage: {
          style: '写实新闻摄影质感，内容认真、对象荒诞',
          subject: `${creatureName}是画面绝对主体，位于画面中心或前景`,
          action: '正处于信中描述的处境',
          place: location ? location.content : (WATERS[journey.water]?.name || ''),
          bgElements: '环境标志性元素',
          mood: '荒诞但温和，认真面对离谱局面'
        }
      },
      replyText: msg.text
    });
    db.attachMessageImage(msg.id, image, image ? 'done' : 'failed');
  } catch (err) {
    db.attachMessageImage(msg.id, null, 'failed');
  }
  return { status: 'done' };
}

// --- 最大静默护栏触发的联系检查点 ---
async function taskContact(task, journey, now) {
  if (journey.status !== 'active') return { status: 'done' };
  const facts = db.getFacts(journey.id);
  let checkpoint;
  try {
    checkpoint = await jevContactCheckpoint({ journey, taskId: task.id, facts, eventCount: journey.event_count, now });
  } catch (err) {
    // JEV 不可用：护栏兜底为寄一封阶段来信（服务护栏决策，如实标记来源）
    db.insertTask({ id: db.rid('TASK'), journeyId: journey.id, kind: 'letter', dueAt: now + PACE.letterAfterContact(), payload: { source: 'silence_guard' }, now });
    return { status: 'done' };
  }
  scheduleAfterContact(journey.id, checkpoint.contact, { now, source: checkpoint.source });
  return { status: 'done' };
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

/**
 * 执行一个已租约任务。返回 {status:'done'} | {status:'retry', dueAt} | {status:'failed', reason}
 * 所有生产入口共用。
 */
async function runTask(task, { now } = {}) {
  const t = now ?? clock.now();
  const journey = db.getJourney(task.journey_id);
  if (!journey) return { status: 'done' };
  // image 任务豁免：给已投递的信补配图，旅程结束/暂停后仍应完成
  if (['ended_user', 'ended_natural', 'aborted', 'paused'].includes(journey.status) && task.kind !== 'image') return { status: 'done' };
  const handler = HANDLERS[task.kind];
  if (!handler) return { status: 'failed', reason: `unknown task kind ${task.kind}` };
  try {
    return await handler(task, journey, t);
  } catch (err) {
    if (err instanceof FlowError) {
      console.warn(`[orchestrator] task ${task.id}(${task.kind}) flow error: ${err.code} ${err.message}`);
      return { status: 'retry', reason: err.code };
    }
    console.error(`[orchestrator] task ${task.id}(${task.kind}) unexpected:`, err.message);
    return { status: 'retry', reason: err.message };
  }
}

// 崩溃/重启恢复：不给任何旅程丢任务（幂等；重复调度不会双事件）
// 同时执行最大静默护栏：active 旅程超过 maxSilence 没有任何用户面向联系时，
// 触发一次联系检查点（服务护栏，不是伪装成生物自主行为）
function reconcileJourneys(now) {
  const journeys = db.getActiveJourneys(200);
  let created = 0;
  for (const journey of journeys) {
    if (db.countOpenTasks(journey.id) > 0) {
      maybeGuardSilence(journey, now);
      continue;
    }
    const latest = db.getLatestEncounter(journey.id);
    let kind = null;
    let dueAt = now + 1000;
    let payload = {};
    if (journey.status === 'preparing' && !latest) {
      kind = 'opening';
    } else if (!latest) {
      kind = 'opening';
    } else if (latest.status === 'proposed') {
      kind = 'decide';
      dueAt = Math.max(now + 1000, latest.created_at + PACE.decideAfterProposal());
      payload = { encounterId: latest.id };
    } else if (latest.status === 'signal_sent') {
      kind = 'decide';
      dueAt = latest.supplyMessageId ? now + 500 : Math.max(now + 1000, latest.signalDueAt || now);
      payload = { encounterId: latest.id };
    } else if (latest.status === 'decided') {
      kind = 'settle';
      payload = { encounterId: latest.id };
    } else if (latest.status === 'resolved') {
      // 结算后若联系检查点没来得及排程（崩溃），补一次检查点而不是直接提案，保住收束机会
      kind = 'contact';
    }
    if (kind && !db.hasOpenTask(journey.id, kind)) {
      db.insertTask({ id: db.rid('TASK'), journeyId: journey.id, kind, dueAt, payload, now });
      created++;
    }
  }
  return created;
}

// 最大静默护栏：只在旅程 active、没有等用户回应的信号、且没有任何联系类任务时触发
function maybeGuardSilence(journey, now) {
  if (journey.status !== 'active') return;
  if (db.hasOpenTask(journey.id, 'contact') || db.hasOpenTask(journey.id, 'letter') || db.hasOpenTask(journey.id, 'final_letter')) return;
  const latest = db.getLatestEncounter(journey.id);
  if (latest && latest.status === 'signal_sent' && !latest.supplyMessageId && now < latest.signalDueAt) return;
  const anchor = db.lastUserFacingAt(journey.id) || journey.created_at;
  if (now - anchor < guards.maxSilenceMs()) return;
  db.insertTask({ id: db.rid('TASK'), journeyId: journey.id, kind: 'contact', dueAt: now + 1000, payload: { source: 'silence_guard' }, now });
  console.log(`[orchestrator] ${journey.id} 触发最大静默护栏，安排联系检查点`);
}

module.exports = {
  ORCHESTRATOR_VERSION,
  startJourney, replyToSignal, setTone, endJourney,
  getJourneyView, getJourneyTimeline, listJourneys, listCreatures,
  runTask, reconcileJourneys, pauseJourney,
  effectiveSendTime, earliestSendAt, budgetRemaining, SIGNAL_URGENCY_MINUTES,
  FlowError
};
