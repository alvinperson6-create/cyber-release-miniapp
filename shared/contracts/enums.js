// 赛博放生 · 公开契约：枚举与不变量
//
// 纯模块。枚举值即持久化取值，改动需要版本化迁移，不允许就地改字面量。

/** 旅程状态：进行中 = preparing | active | paused；终态 = ended_* | aborted */
const JOURNEY_STATUS = {
  PREPARING: 'preparing',
  ACTIVE: 'active',
  PAUSED: 'paused',
  ENDED_USER: 'ended_user',
  ENDED_NATURAL: 'ended_natural',
  ABORTED: 'aborted'
};

const TERMINAL_STATUSES = [
  JOURNEY_STATUS.ENDED_USER,
  JOURNEY_STATUS.ENDED_NATURAL,
  JOURNEY_STATUS.ABORTED
];

const OPEN_STATUSES = [
  JOURNEY_STATUS.PREPARING,
  JOURNEY_STATUS.ACTIVE,
  JOURNEY_STATUS.PAUSED
];

function isTerminal(status) { return TERMINAL_STATUSES.includes(status); }
function isOpen(status) { return OPEN_STATUSES.includes(status); }

/** 用户面向阶段（前端渲染依据，进行中不暴露遭遇内容） */
const JOURNEY_PHASE = {
  PREPARING: 'preparing',
  JOURNEYING: 'journeying',
  AWAITING_REPLY: 'awaiting_reply',
  EXPERIENCING: 'experiencing',
  PAUSED: 'paused',
  ENDED: 'ended'
};

/** 消息类型。system 是服务提示，永远与生物来信分开计数与展示 */
const MESSAGE_KIND = {
  SIGNAL: 'signal',
  LETTER: 'letter',
  FINAL_LETTER: 'final_letter',
  USER_REPLY: 'user_reply',
  SYSTEM: 'system'
};

/** 用户真正看到的"生物来信"（静默护栏与最小间隔只看这三类） */
const USER_FACING_KINDS = [MESSAGE_KIND.SIGNAL, MESSAGE_KIND.LETTER, MESSAGE_KIND.FINAL_LETTER];

const ENCOUNTER_STATUS = {
  PROPOSED: 'proposed',
  SIGNAL_SENT: 'signal_sent',
  DECIDED: 'decided',
  RESOLVED: 'resolved'
};

/**
 * 模型操作名（阶段 B：显式命名，替代"按提示词文案分流"）
 *
 * fixture 必须按这些名字供数；出现未知名字直接失败，不回退真实网络。
 */
const MODEL_OP = {
  OPENING: 'opening',
  PROPOSAL: 'proposal',
  REPROPOSAL: 'reproposal',
  SETTLEMENT: 'settlement',
  SETTLEMENT_REPAIR: 'settlement_repair',
  SIGNAL_WRITE: 'signal_write',
  LETTER_WRITE: 'letter_write',
  FINAL_LETTER_WRITE: 'final_letter_write',
  FINAL_LETTER_REPAIR: 'final_letter_repair',
  SITUATION_RECOGNITION: 'situation_recognition',
  ACTION_DECISION: 'action_decision',
  CONTACT_CHECKPOINT: 'contact_checkpoint',
  SETTLEMENT_CHECK: 'settlement_check',
  LETTER_CHECK: 'letter_check',
  DEDUP_CHECK: 'dedup_check',
  IMAGE: 'image'
};

const MODEL_OP_NAMES = Object.values(MODEL_OP);

/**
 * 业务提交结果语义（阶段 D：区分 applied / already_applied / stale / cancelled）
 *
 * trace 不得把所有结果都记成"完成"。
 */
const COMMIT_RESULT = {
  APPLIED: 'applied',                   // 本次真正落账
  ALREADY_APPLIED: 'already_applied',   // 同一 operation 已落过账，幂等命中
  STALE: 'stale',                       // 输入快照/版本已不匹配，丢弃
  CANCELLED: 'cancelled',               // 旅程已终态/任务已取消，丢弃
  CONFLICT: 'conflict'                  // 乐观锁冲突，交给上层
};

const COMMIT_RESULT_NAMES = Object.values(COMMIT_RESULT);

/**
 * 调度结果语义（阶段 D：正常等待与错误重试必须分开）
 *
 * DEFER 不消耗错误重试次数；只有 RETRY 才走退避与重试上限。
 */
const SCHEDULER_RESULT = {
  DONE: 'done',       // 完成
  DEFER: 'defer',     // 正常等待（未到截止/未到投递时间），按 dueAt 重新排
  RETRY: 'retry',     // 真实错误，退避重试，计入 attempts
  FAILED: 'failed'    // 永久失败
};

const TONE = { GENTLE: 'gentle', BALANCED: 'balanced', ABSURD: 'absurd' };
const TONE_VALUES = Object.values(TONE);

module.exports = {
  JOURNEY_STATUS, TERMINAL_STATUSES, OPEN_STATUSES, isTerminal, isOpen,
  JOURNEY_PHASE, MESSAGE_KIND, USER_FACING_KINDS, ENCOUNTER_STATUS,
  MODEL_OP, MODEL_OP_NAMES,
  COMMIT_RESULT, COMMIT_RESULT_NAMES,
  SCHEDULER_RESULT,
  TONE, TONE_VALUES
};
