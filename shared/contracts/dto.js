// 赛博放生 · 公开契约：对外 DTO 形状与运行时校验
//
// 阶段 C.1：HTTP 序列化只输出明确 DTO。内部数据库行、ownerKey、提示词、
// 模型原始响应都不得成为公开 DTO。
//
// 本模块既是"序列化白名单"，也是"响应校验"：外部响应在边界被校验后才
// 进入客户端缓存，非法响应如实报错而不是静默写入。

const { JOURNEY_PHASE, MESSAGE_KIND, TERMINAL_STATUSES } = require('./enums');
const { CREATURES, WATERS } = require('./vocabulary');

/** 对外契约版本：破坏性变更时 +1，客户端可据此拒绝不兼容响应 */
const CONTRACT_VERSION = 'journey-contract-v2';

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const isStr = (v) => typeof v === 'string';
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

const KNOWN_PHASES = new Set(Object.values(JOURNEY_PHASE));
const KNOWN_KINDS = new Set(Object.values(MESSAGE_KIND));
const KNOWN_TONES = new Set(['gentle', 'balanced', 'absurd']);

/**
 * 消息 DTO。
 * 不含 journeyId（由外层路径隐含）、不含内部 meta 细节，只暴露 UI 需要的判定位。
 */
function toMessageDto(m, { now }) {
  return {
    id: m.id,
    kind: m.kind,
    title: m.title ?? null,
    text: m.text,
    image: m.image ?? null,
    imageStatus: m.imageStatus ?? null,
    status: m.status,
    sentAt: m.sentAt,
    // 未到投递时间的消息不得提前可见（阶段 1.2.7）
    visible: m.sentAt <= now,
    meta: {
      isFinal: m.kind === MESSAGE_KIND.FINAL_LETTER,
      ontime: m.meta?.ontime ?? null,
      late: m.meta?.late ?? null
    }
  };
}

/** 待回应信号 DTO：只暴露这一件已寄出信号的未决遭遇 */
function toPendingSignalDto(enc, sigMsg, now) {
  if (!enc || !sigMsg || enc.status !== 'signal_sent') return null;
  if (sigMsg.sentAt > now) return null; // 未来投递时间不得提前可见
  const actions = Array.isArray(enc.proposal?.actions) ? enc.proposal.actions : [];
  return {
    encounterId: enc.id,
    messageId: enc.signalMessageId,
    text: sigMsg.text,
    sentAt: sigMsg.sentAt,
    dueAt: enc.signalDueAt,
    remainingMs: Math.max(0, enc.signalDueAt - now),
    replied: !!enc.supplyMessageId,
    actions: actions.map(a => ({ id: a.id, label: a.label, cost: a.cost }))
  };
}

/**
 * 旅程视图 DTO —— 服务端权威快照的完整序列化。
 *
 * 关键：这里的字段就是"服务端副本"的全部内容。客户端自己的草稿、展开状态、
 * 请求状态不属于本 DTO，必须分开存放（阶段 E）。
 *
 * 注意：stateVersion 只服务事实/决策并发，**不是完整前端 snapshotVersion**；
 * 它不覆盖每次消息、语气或图片变化（见 docs/agent-environment-design.md）。
 */
function toJourneyViewDto(journey, { latestEnc, motivation, allMessages, facts, lastResolved, now }) {
  const phase = computePhase(journey, latestEnc);
  const species = journey.species;
  return {
    id: journey.id,
    creatureId: journey.creature_id,
    creatureName: CREATURES[species]?.name || species,
    creatureEmoji: CREATURES[species]?.emoji || '🐚',
    species,
    water: journey.water,
    waterName: WATERS[journey.water]?.name || journey.water,
    status: journey.status,
    phase,
    isEnded: TERMINAL_STATUSES.includes(journey.status),
    pauseReason: journey.pause_reason || null,
    tone: journey.tone,
    goal: journey.status === 'preparing' ? null : (journey.goal || null),
    motivation: motivation ? {
      version: motivation.version,
      status: motivation.status,
      rawText: motivation.rawText,
      items: (motivation.items || []).filter(i => i.usable).map(i => ({ id: i.id, label: i.label, evidence: i.evidenceText }))
    } : null,
    pendingSignal: toPendingSignalDto(latestEnc, latestEnc?.signalMessageId ? signalOf(latestEnc) : null, now),
    experiencing: latestEnc && latestEnc.status === 'decided' ? {
      encounterId: latestEnc.id,
      title: latestEnc.proposal.title,
      chosenAction: (latestEnc.proposal.actions.find(a => a.id === latestEnc.chosenAction) || {}).label
        || latestEnc.chosenAction,
      stage: 'settling'
    } : null,
    lastResolved: lastResolved || null,
    messages: allMessages.map(m => toMessageDto(m, { now })),
    eventCount: journey.event_count,
    factsCount: facts,
    createdAt: journey.created_at,
    stateVersion: journey.state_version,
    serverTime: now
  };
}

function computePhase(journey, latestEnc) {
  if (journey.status === 'preparing') return JOURNEY_PHASE.PREPARING;
  if (journey.status === 'paused') return JOURNEY_PHASE.PAUSED;
  if (TERMINAL_STATUSES.includes(journey.status)) return JOURNEY_PHASE.ENDED;
  if (!latestEnc) return JOURNEY_PHASE.JOURNEYING;
  if (latestEnc.status === 'signal_sent') return JOURNEY_PHASE.AWAITING_REPLY;
  if (latestEnc.status === 'decided') return JOURNEY_PHASE.EXPERIENCING;
  return JOURNEY_PHASE.JOURNEYING; // proposed：隐藏遭遇内容
}

// 由 encounters 行内联的 signal 文本在调用方组装；这里只做兜底
let _signalLookup = () => null;
function setSignalLookup(fn) { _signalLookup = fn; }
function signalOf(enc) { return _signalLookup(enc); }

// ==================== 响应校验（客户端边界） ====================

/**
 * 校验 JourneyView 响应。
 * 非法响应必须如实报错且不写入缓存（阶段 E）——这是挡住"晚回/串扰静默污染视图"
 * 的第一道闸。
 */
function validateJourneyView(v) {
  if (!isObj(v)) return { ok: false, reason: 'not_object' };
  if (!isStr(v.id) || !v.id) return { ok: false, reason: 'missing_id' };
  if (!isStr(v.status)) return { ok: false, reason: 'missing_status' };
  if (!KNOWN_PHASES.has(v.phase)) return { ok: false, reason: 'bad_phase' };
  if (!KNOWN_TONES.has(v.tone)) return { ok: false, reason: 'bad_tone' };
  if (!Array.isArray(v.messages)) return { ok: false, reason: 'bad_messages' };
  for (const m of v.messages) {
    if (!isObj(m) || !isStr(m.id) || !KNOWN_KINDS.has(m.kind)) return { ok: false, reason: 'bad_message_item' };
    if (!isStr(m.text)) return { ok: false, reason: 'bad_message_text' };
  }
  if (!isNum(v.serverTime)) return { ok: false, reason: 'missing_server_time' };
  if (v.pendingSignal != null) {
    const p = v.pendingSignal;
    if (!isObj(p) || !isStr(p.encounterId) || !isStr(p.messageId) || !isNum(p.dueAt)) {
      return { ok: false, reason: 'bad_pending_signal' };
    }
    if (!Array.isArray(p.actions)) return { ok: false, reason: 'bad_signal_actions' };
  }
  return { ok: true };
}

/** 校验命令结果响应 */
function validateCommandResult(v) {
  if (!isObj(v)) return { ok: false, reason: 'not_object' };
  if (v.ok === true) return { ok: true };
  if (v.ok === false && isStr(v.code)) return { ok: true };
  return { ok: false, reason: 'bad_command_result' };
}

module.exports = {
  CONTRACT_VERSION,
  toMessageDto, toPendingSignalDto, toJourneyViewDto, computePhase,
  setSignalLookup,
  validateJourneyView, validateCommandResult
};
