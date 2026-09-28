// 赛博放生 · 功能开关与服务护栏（旅程 v2）
//
// 所有开关只读环境变量，默认值集中在这一处。
// 这些是服务护栏（程序拥有），不是用户拍板的剧情长度或发送日期：
//   J_SIGNAL_DEADLINE_MS   可回应信号的补给截止时间（默认 6h）
//   J_MAX_SILENCE_MS       最大静默：超过即触发一次联系检查点（默认 36h）
//   J_MIN_INTERVAL_MS      两次寄给用户的消息最小间隔（默认 2h）
//   J_QUIET_START/END      安静时段（本地小时，默认 1-7 点，不寄信）
//   J_MAX_EVENTS           单程遭遇数上限（默认 12）
//   J_MAX_MODEL_CALLS      单程模型调用总预算（默认 60，含 JEV）
//   J_MAX_TASK_ATTEMPTS    任务重试上限（默认 4，超限旅程如实暂停）
//   J_IMAGE_BUDGET         单程配图预算（默认 1；0 关闭）
//   J_LEASE_MS             任务租约时长（默认 5 分钟，进程崩溃后可回收）
//   J_TICK_MS              调度器 tick 间隔（默认 10s）
//   J_TIME_SCALE           时长缩放（部署/演示配置，非线上推进 API；默认 1）

const { parseBoolEnv } = require('./flags-util');

function num(name, d, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const n = parseFloat(process.env[name]);
  if (!Number.isFinite(n) || n < min || n > max) return d;
  return n;
}

function scaleMs(ms) {
  const s = num('J_TIME_SCALE', 1, { min: 0.000001, max: 100000 });
  return Math.max(250, Math.round(ms / s));
}

const guards = {
  signalDeadlineMs: () => scaleMs(num('J_SIGNAL_DEADLINE_MS', 6 * 3600e3, { min: 1000 })),
  maxSilenceMs: () => scaleMs(num('J_MAX_SILENCE_MS', 36 * 3600e3, { min: 60e3 })),
  minIntervalMs: () => scaleMs(num('J_MIN_INTERVAL_MS', 2 * 3600e3, { min: 0 })),
  quietHours: () => {
    const start = num('J_QUIET_START', 1, { min: 0, max: 23 });
    const end = num('J_QUIET_END', 7, { min: 0, max: 24 });
    return { start, end };
  },
  maxEvents: () => num('J_MAX_EVENTS', 12, { min: 1, max: 200 }),
  maxModelCalls: () => num('J_MAX_MODEL_CALLS', 60, { min: 1, max: 100000 }),
  maxTaskAttempts: () => num('J_MAX_TASK_ATTEMPTS', 4, { min: 1, max: 50 }),
  imageBudget: () => num('J_IMAGE_BUDGET', 1, { min: 0, max: 50 }),
  leaseMs: () => num('J_LEASE_MS', 5 * 60e3, { min: 1000 }),
  tickMs: () => num('J_TICK_MS', 10e3, { min: 500 }),
  backoffMs: (attempt) => scaleMs(Math.min(30 * 60e3, 30e3 * Math.pow(2, attempt - 1))),

  // 幽默语气：gentle(轻一点) | balanced(默认) | absurd(更荒唐一点)
  toneValid: (t) => ['gentle', 'balanced', 'absurd'].includes(t),

  // 旅程内核总开关：保留排查后门，缺省开启
  journeyEnabled: () => parseBoolEnv('JOURNEY_ENABLED', true)
};

// JEV 处境识别的置信度阈值（situations.js 沿用上一轮校准值，见 docs/jev-validation.md）
function thresholds() {
  const num = (v, d) => {
    const n = parseFloat(v);
    return Number.isFinite(n) && n >= 0 && n <= 1 ? n : d;
  };
  return {
    situationMinConfidence: num(process.env.JEV_SITUATION_MIN_CONFIDENCE, 0.45)
  };
}

module.exports = { guards, scaleMs, thresholds, parseBoolEnv };
