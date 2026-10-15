// 赛博放生 · 文本模型适配器
//
// 边界（阶段 3.1）：模型 adapter 只返回模型结果，不拥有故事事实提交权。
// 提示词构造与 schema 校验在纯模块（features/journey/context、commits）里，
// 本文件不构造提示词、不校验业务内容。
//
// 统一入口（阶段 D）：所有外部调用都经过这里，预算与台账集中记账。
// 每次真正的网络尝试（含失败与适配器内部重试）都按规则记账；
// 无网络调用的预算拒绝用单独状态记录，不混入真实尝试。

const { MODEL_OP, MODEL_OP_NAMES } = require('../../shared/contracts/enums');

const PROVIDERS = {
  openai: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  claude: { baseUrl: 'https://api.anthropic.com/v1', model: 'claude-3-5-haiku-20241022' },
  doubao: { baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', model: 'doubao-seed-2-0-lite-260215' },
  qianfan: { baseUrl: 'https://qianfan.baidubce.com/v2', model: 'deepseek-v4-flash' }
};

function getConfig() {
  const provider = (process.env.AI_PROVIDER || 'doubao').toLowerCase();
  const preset = PROVIDERS[provider] || PROVIDERS.doubao;
  return {
    provider,
    apiKey: process.env.AI_API_KEY || process.env.OPENAI_API_KEY || '',
    baseUrl: process.env.AI_BASE_URL || preset.baseUrl,
    model: process.env.AI_MODEL || preset.model
  };
}

function isAIEnabled() {
  return !!getConfig().apiKey;
}

function assertKnownOperation(op) {
  if (!MODEL_OP_NAMES.includes(op)) {
    // 未知操作必须显式失败：fixture 场景靠这个保证不会静默回退真实网络
    throw new Error(`unknown model operation: ${op}`);
  }
}

/**
 * 一次聊天补全。
 * @returns {{ok:true, content, usage, model, latencyMs}|{ok:false, error, latencyMs}}
 */
async function chatCompletion(messages, options = {}) {
  const cfg = getConfig();
  const url = cfg.baseUrl + '/chat/completions';
  const body = {
    model: cfg.model,
    messages,
    temperature: options.temperature ?? 0.85,
    max_tokens: options.max_tokens ?? 1200
  };

  // 千帆 DeepSeek 混合推理模型默认开启深度思考，会挤占 max_tokens 导致
  // 正式 content 为空；默认关闭，仅当调用方显式要求时保留。
  if (cfg.provider === 'qianfan' && options.thinking !== true) {
    body.thinking = { type: 'disabled' };
  }

  const t0 = Date.now();
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${cfg.apiKey}`
    },
    body: JSON.stringify(body)
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    const err = new Error(`AI API ${resp.status}: ${text.slice(0, 200)}`);
    err.latencyMs = Date.now() - t0;
    err.status = resp.status;
    throw err;
  }

  const data = await resp.json();
  const msg0 = data.choices?.[0]?.message || {};
  const rawUsage = data.usage || {};
  return {
    content: msg0.content || '',
    usage: {
      input_tokens: rawUsage.input_tokens ?? rawUsage.prompt_tokens ?? 0,
      output_tokens: rawUsage.output_tokens ?? rawUsage.completion_tokens ?? 0,
      total_tokens: rawUsage.total_tokens ?? null
    },
    model: data.model || cfg.model,
    finishReason: data.choices?.[0]?.finish_reason,
    latencyMs: Date.now() - t0
  };
}

/**
 * 创建文本模型适配器实例（依赖注入）。
 * @param deps.clock 可控时钟
 * @param deps.onCall 每次真实网络尝试后的记账回调
 */
function createTextModel({ clock, onCall = () => {} } = {}) {
  /**
   * 带预算与台账的统一调用入口。
   * @param op MODEL_OP 中的显式操作名
   * @param budget {{allowed:boolean, reason?:string}} 由调用方通过 budget gate 得出
   */
  async function invoke({
    op, messages, temperature, maxTokens, thinking,
    journeyId = null, taskId = null, encounterId = null,
    operationId = null, budget = { allowed: true }, now
  }) {
    assertKnownOperation(op);
    const cfg = getConfig();
    const t = now ?? (clock ? clock.now() : Date.now());

    // 无网络调用的预算拒绝：单独记账，不与真实尝试混淆
    if (budget.allowed === false) {
      onCall({
        journeyId, taskId, encounterId, operationId,
        operationKind: op, attempt: null,
        kind: op, provider: cfg.provider, model: cfg.model,
        usage: null, latencyMs: 0, status: 'budget_denied',
        error: budget.reason || 'budget_exhausted', now: t
      });
      return { ok: false, error: budget.reason || 'budget_exhausted', budgetDenied: true };
    }

    const t0 = Date.now();
    try {
      const r = await chatCompletion(messages, {
        temperature, max_tokens: maxTokens, thinking
      });
      onCall({
        journeyId, taskId, encounterId, operationId,
        operationKind: op, attempt: 1,
        kind: op, provider: cfg.provider, model: r.model,
        usage: r.usage, latencyMs: r.latencyMs, status: 'ok', error: null, now: t
      });
      return { ok: true, content: r.content, meta: { model: r.model, usage: r.usage, latencyMs: r.latencyMs } };
    } catch (err) {
      const latencyMs = err.latencyMs || (Date.now() - t0);
      // 失败的真实尝试同样记账（阶段 D：修复与失败都算用量）
      onCall({
        journeyId, taskId, encounterId, operationId,
        operationKind: op, attempt: 1,
        kind: op, provider: cfg.provider, model: cfg.model,
        usage: null, latencyMs, status: 'error', error: err.message, now: t
      });
      return { ok: false, error: err.message, meta: { latencyMs } };
    }
  }

  return { invoke, getConfig, isEnabled: isAIEnabled };
}

module.exports = { createTextModel, chatCompletion, getConfig, isAIEnabled, assertKnownOperation, MODEL_OP };
