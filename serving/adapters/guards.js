// 赛博放生 · 功能开关与服务护栏
//
// 所有开关只读环境变量，默认值集中在这一处。开关是服务护栏（程序拥有），
// 不是用户拍板的剧情长度或发送日期。
//
// 这是"纯策略"模块：只读 env，不做 IO、不连数据库、不触模型。

function num(name, d, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const n = parseFloat(process.env[name]);
  if (!Number.isFinite(n) || n < min || n > max) return d;
  return n;
}

function parseBoolEnv(name, d = false) {
  const raw = process.env[name];
  if (raw == null || raw === '') return d;
  return !['0', 'false', 'no', 'off'].includes(String(raw).toLowerCase());
}

function scaleMs(ms) {
  const s = num('J_TIME_SCALE', 1, { min: 0.000001, max: 100000 });
  return Math.max(250, Math.round(ms / s));
}

const guards = {
  signalDeadlineMs: () => scaleMs(num('J_SIGNAL_DEADLINE_MS', 6 * 3600e3, { min: 1000 })),
  maxSilenceMs: () => scaleMs(num('J_MAX_SILENCE_MS', 36 * 3600e3, { min: 60e3 })),
  minIntervalMs: () => scaleMs(num('J_MIN_INTERVAL_MS', 2 * 3600e3, { min: 0 })),
  quietHours: () => ({
    start: num('J_QUIET_START', 1, { min: 0, max: 23 }),
    end: num('J_QUIET_END', 7, { min: 0, max: 24 })
  }),
  maxEvents: () => num('J_MAX_EVENTS', 12, { min: 1, max: 200 }),
  maxModelCalls: () => num('J_MAX_MODEL_CALLS', 60, { min: 1, max: 100000 }),
  maxTaskAttempts: () => num('J_MAX_TASK_ATTEMPTS', 4, { min: 1, max: 50 }),
  imageBudget: () => num('J_IMAGE_BUDGET', 1, { min: 0, max: 50 }),
  leaseMs: () => num('J_LEASE_MS', 5 * 60e3, { min: 1000 }),
  tickMs: () => num('J_TICK_MS', 10e3, { min: 500 }),
  backoffMs: (attempt) => scaleMs(Math.min(30 * 60e3, 30e3 * Math.pow(2, attempt - 1))),

  toneValid: (t) => ['gentle', 'balanced', 'absurd'].includes(t),
  journeyEnabled: () => parseBoolEnv('JOURNEY_ENABLED', true)
};

/** JEV 处境识别置信度阈值（见 docs/jev-validation.md 的校准记录） */
function thresholds() {
  const n = (v, d) => {
    const x = parseFloat(v);
    return Number.isFinite(x) && x >= 0 && x <= 1 ? x : d;
  };
  return {
    situationMinConfidence: n(process.env.JEV_SITUATION_MIN_CONFIDENCE, 0.45)
  };
}

/** 信号截止紧急度分桶：JEV 选择寄信号时选桶，程序映射为分钟（1-120 区间） */
const SIGNAL_URGENCY_MINUTES = {
  instant: 3,
  urgent: 10,
  soon: 30,
  unhurried: 60,
  patient: 120
};

module.exports = { guards, scaleMs, thresholds, parseBoolEnv, SIGNAL_URGENCY_MINUTES };
