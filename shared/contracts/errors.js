// 赛博放生 · 公开契约：错误码与 HTTP 状态映射
//
// 纯模块：不 import 任何 renderer/serving 模块，不读 env，不做 IO。
// 浏览器与服务共用；服务端状态码与前端分支都以这里为唯一来源。

/**
 * 错误码语义（阶段 C.5：状态码在契约中固定，与 UI 一致）
 *
 * 4xx = 请求本身不合法或与当前状态冲突，重试无意义；
 * 5xx/503 = 服务侧问题，换时间重试可能成功。
 */
const ERROR_CODES = {
  // —— 归属与存在（跨 owner 一律 404，不泄露"存在但不是你"）
  journey_not_found: { http: 404, message: '旅程不存在' },
  creature_not_found: { http: 404, message: '生物不存在' },
  signal_not_found: { http: 404, message: '信号不存在' },
  encounter_not_found: { http: 404, message: '遭遇不存在' },

  // —— 输入不合法
  invalid_species: { http: 400, message: '未知生物种类' },
  invalid_water: { http: 400, message: '未知水域' },
  empty_feeling: { http: 400, message: '请写下你想放生的烦恼' },
  feeling_too_long: { http: 400, message: '烦恼太长了' },
  species_mismatch: { http: 400, message: '生物种类与既有记录不一致' },
  invalid_tone: { http: 400, message: '未知语气' },
  empty_reply: { http: 400, message: '回复内容为空' },
  reply_too_long: { http: 400, message: '回复太长了' },
  missing_reply_target: { http: 400, message: '缺少回复目标（signalMessageId / encounterId）' },
  invalid_request_id: { http: 400, message: 'requestId 不合法' },

  // —— 与当前状态冲突（换时间或改目标才可能成功）
  journey_ended: { http: 409, message: '本程已结束，留言不会被带进下一程' },
  already_ended: { http: 409, message: '本程已经结束' },
  journey_not_finished: { http: 403, message: '旅程还在进行中：它想自己决定什么时候讲给你听。这一程结束后，这里会展开完整时间线。' },
  signal_already_decided: { http: 409, message: '这个信号对应的遭遇已经有结果了' },
  idempotency_conflict: { http: 409, message: '同一 requestId 携带了不同的内容' },
  not_found: { http: 404, message: '接口不存在' },

  // —— 服务侧
  journey_disabled: { http: 503, message: '旅程功能暂时关闭' },
  internal_error: { http: 500, message: '服务器内部错误' }
};

function httpStatusFor(code) {
  return (ERROR_CODES[code] || ERROR_CODES.internal_error).http;
}

function messageFor(code) {
  return (ERROR_CODES[code] || ERROR_CODES.internal_error).message;
}

/** 归一化任意错误为对外 DTO：绝不泄漏堆栈或内部细节。 */
function toErrorDto(code, messageOverride) {
  const known = ERROR_CODES[code];
  return {
    ok: false,
    code: known ? code : 'internal_error',
    message: messageOverride || (known ? known.message : '服务器内部错误')
  };
}

module.exports = { ERROR_CODES, httpStatusFor, messageFor, toErrorDto };
