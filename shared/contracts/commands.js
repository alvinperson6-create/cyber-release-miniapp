// 赛博放生 · 公开契约：命令输入校验（纯函数）
//
// 阶段 C：输入、外部响应及持久任务 payload 在边界运行时校验。
// 本模块只做形状与取值判断，不访问数据库、不读环境变量、不抛业务异常
// （统一返回 {ok, code}，由调用方决定如何映射成响应）。

const { ERROR_CODES } = require('./errors');
const { TONE_VALUES } = require('./enums');
const { CREATURE_IDS, WATER_IDS } = require('./vocabulary');

const MAX_FEELING = 500;
const MAX_REPLY = 120;

/**
 * requestId 规范化。
 *
 * 幂等键按 owner 与操作分域：同一个 requestId 在不同 owner、不同 operation
 * 下互不串用（域在存储层按 (owner_key, operation, request_id) 唯一约束体现）。
 *
 * 只接受安全字符，避免把任意用户串直接当键落库；长度上限 128。
 */
const REQUEST_ID_RE = /^[A-Za-z0-9_.:-]{8,128}$/;

function normalizeRequestId(value) {
  if (value == null || value === '') return { ok: true, requestId: null };
  if (typeof value !== 'string') return { ok: false, code: 'invalid_request_id' };
  const trimmed = value.trim();
  if (!REQUEST_ID_RE.test(trimmed)) return { ok: false, code: 'invalid_request_id' };
  return { ok: true, requestId: trimmed };
}

const str = (v) => (typeof v === 'string' ? v.trim() : '');

/**
 * 放生 / 建程命令。
 * @returns {{ok:true, value:object}|{ok:false, code:string}}
 */
function parseReleaseCommand(input = {}) {
  const species = str(input.species) || str(input.creature); // creature 为历史字段别名
  // 取值合法性在契约层就判定：浏览器与服务共用同一份词表，不在这里放过
  if (!species || !CREATURE_IDS.includes(species)) return { ok: false, code: 'invalid_species' };
  const water = str(input.water);
  if (!water || !WATER_IDS.includes(water)) return { ok: false, code: 'invalid_water' };

  const feeling = str(input.feeling);
  if (!feeling) return { ok: false, code: 'empty_feeling' };
  if (feeling.length > MAX_FEELING) return { ok: false, code: 'feeling_too_long' };

  const tone = input.tone == null || input.tone === '' ? 'balanced' : str(input.tone);
  if (!TONE_VALUES.includes(tone)) return { ok: false, code: 'invalid_tone' };

  const creatureId = str(input.creatureId) || null;

  const rid = normalizeRequestId(input.requestId);
  if (!rid.ok) return rid;

  return {
    ok: true,
    value: { species, water, feeling, tone, creatureId, requestId: rid.requestId }
  };
}

/**
 * 回应信号命令（阶段 C.3：必须显式给目标）。
 *
 * 关键约定：缺少回复目标一律拒绝，**不做"静默推断最新信号"的兼容**。
 * 旧调用方必须显式升级；这是刻意的破坏性变更，避免旧信号请求绑定到新信号。
 */
function parseReplyCommand(input = {}) {
  const text = str(input.text);
  if (!text) return { ok: false, code: 'empty_reply' };
  if (text.length > MAX_REPLY) return { ok: false, code: 'reply_too_long' };

  const signalMessageId = str(input.signalMessageId) || null;
  const encounterId = str(input.encounterId) || null;
  if (!signalMessageId && !encounterId) return { ok: false, code: 'missing_reply_target' };

  const rid = normalizeRequestId(input.requestId);
  if (!rid.ok) return rid;

  return {
    ok: true,
    value: {
      text,
      signalMessageId,
      encounterId,
      // late: 用户显式承认这是迟到留言；不传则由 Host 按截止时间判定
      late: input.late === true ? true : (input.late === false ? false : null),
      requestId: rid.requestId
    }
  };
}

/** 语气偏好命令（只影响未来生成） */
function parseToneCommand(input = {}) {
  const tone = str(input.tone);
  if (!TONE_VALUES.includes(tone)) return { ok: false, code: 'invalid_tone' };
  const rid = normalizeRequestId(input.requestId);
  if (!rid.ok) return rid;
  return { ok: true, value: { tone, requestId: rid.requestId } };
}

/** 结束旅程命令（立即生效，不等模型） */
function parseEndCommand(input = {}) {
  const rid = normalizeRequestId(input.requestId);
  if (!rid.ok) return rid;
  return { ok: true, value: { requestId: rid.requestId } };
}

const PARSERS = {
  release: parseReleaseCommand,
  replyToSignal: parseReplyCommand,
  setTone: parseToneCommand,
  endJourney: parseEndCommand
};

/**
 * 幂等载荷指纹：同键同 payload 返回稳定结果；同键不同 payload 返回冲突。
 *
 * 只对影响业务结果的字段取指纹，requestId 自身不参与。
 */
function fingerprintOf(operation, value) {
  const { requestId, ...rest } = value || {};
  const canonical = Object.keys(rest).sort().map(k => `${k}=${JSON.stringify(rest[k])}`).join('&');
  return `${operation}:${canonical}`;
}

module.exports = {
  MAX_FEELING, MAX_REPLY, REQUEST_ID_RE,
  normalizeRequestId,
  parseReleaseCommand, parseReplyCommand, parseToneCommand, parseEndCommand,
  PARSERS, fingerprintOf, ERROR_CODES
};
