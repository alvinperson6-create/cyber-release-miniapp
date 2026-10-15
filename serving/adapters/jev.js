// 赛博放生 · JEV 判断适配器（typesafe.ai SystemOne API）
//
// 边界（阶段 3.1）：只返回判断结果，不提交任何故事事实。
// 行动选择的提交权在 commits 层，且必须复核租约与输入快照。
//
// 职责：
// - 只做有限选项(Choice)/量表(Score)/是非命题(Noul)判断，不做自由文本生成
// - 同一请求中的问题彼此独立；代码负责组合答案
// - Noul 没有单独 confidence 字段；confidence 不是事实正确性保证
// - 校验单条答案结构：缺字段/类型不符视为 FORMAT 失败，
//   绝不把解析失败伪装成判断通过
//
// 环境变量：JEV_API_KEY / JEV_BASE_URL / JEV_MODEL / JEV_TIMEOUT_MS
// JEV_PROXY：显式代理（JEV 按出口 IP 做地域限制，受限区域直连会拿到 451；
//            Node 的 fetch 不读系统代理设置，需要显式指定）

const { MODEL_OP } = require('../../shared/contracts/enums');
const { createHttpClient } = require('./http-client');

const DEFAULT_BASE_URL = 'https://api.typesafe.ai/v1';
const DEFAULT_MODEL = 'jev-latest';

class JeVError extends Error {
  // code: NO_CREDENTIAL | AUTH | VALIDATION | RATE_LIMIT | TIMEOUT | NETWORK | HTTP | FORMAT
  constructor(code, message, detail) {
    super(message);
    this.name = 'JeVError';
    this.code = code;
    this.detail = detail;
  }
}

function getConfig() {
  return {
    apiKey: process.env.JEV_API_KEY || '',
    baseUrl: (process.env.JEV_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, ''),
    model: process.env.JEV_MODEL || DEFAULT_MODEL,
    timeoutMs: parseInt(process.env.JEV_TIMEOUT_MS || '30000', 10) || 30000,
    // 显式代理优先；不给则由 http-client 读 HTTPS_PROXY/HTTP_PROXY
    proxyUrl: process.env.JEV_PROXY || null
  };
}

function isJeVEnabled() {
  return !!getConfig().apiKey && process.env.JEV_ENABLED !== '0';
}

function validateAnswer(id, q, a) {
  if (!a || typeof a !== 'object') throw new JeVError('FORMAT', `答案 ${id} 缺失或非对象`);
  if (q.type === 'noul') {
    if (typeof a.noul !== 'number' || a.noul < 0 || a.noul > 1) {
      throw new JeVError('FORMAT', `答案 ${id} 缺少合法 noul 值`, a);
    }
  } else if (q.type === 'choice') {
    const options = Object.keys(q.criteria || {});
    if (typeof a.choice !== 'string' || !options.includes(a.choice)) {
      throw new JeVError('FORMAT', `答案 ${id} 的 choice 不在合法选项中`, { choice: a.choice, options });
    }
    if (!a.probabilities || typeof a.probabilities !== 'object') {
      throw new JeVError('FORMAT', `答案 ${id} 缺少 probabilities`, a);
    }
  } else if (q.type === 'score') {
    if (typeof a.score !== 'number') {
      throw new JeVError('FORMAT', `答案 ${id} 缺少合法 score`, a);
    }
  }
}

/**
 * 创建 JEV 适配器实例（依赖注入）。
 *
 * @param deps.clock
 * @param deps.onCall 记账回调，与文本模型走同一张台账与同一套预算
 */
function createJev({ clock, onCall = () => {} } = {}) {
  /**
   * @param op 显式操作名（MODEL_OP）
   * @param transportMaxAttempts 适配器内部重试次数；每次都是一次真实网络尝试
   */
  async function judge({
    op, state, questions, journeyId = null, taskId = null,
    encounterId = null, operationId = null, now,
    budget = { allowed: true }, transportMaxAttempts = 2
  }) {
    const cfg = getConfig();
    const t = now ?? (clock ? clock.now() : Date.now());
    const opName = op || MODEL_OP.ACTION_DECISION;

    if (budget.allowed === false) {
      onCall({
        journeyId, taskId, encounterId, operationId, operationKind: opName, attempt: null,
        kind: opName, provider: 'typesafe', model: cfg.model, usage: null,
        latencyMs: 0, status: 'budget_denied', error: budget.reason || 'budget_exhausted', now: t
      });
      return { available: false, budgetDenied: true, reason: budget.reason || 'budget_exhausted' };
    }

    if (!cfg.apiKey) {
      onCall({
        journeyId, taskId, encounterId, operationId, operationKind: opName, attempt: null,
        kind: opName, provider: 'typesafe', model: cfg.model, usage: null,
        latencyMs: 0, status: 'error', error: '缺少 JEV_API_KEY', now: t
      });
      return { available: false, reason: 'NO_CREDENTIAL' };
    }

    const questionIds = Object.keys(questions || {});
    if (!questionIds.length) {
      return { available: false, reason: 'VALIDATION' };
    }

    const maxAttempts = Math.max(1, transportMaxAttempts);
    let lastErr = null;
    let timeoutMs = cfg.timeoutMs;

    // 代理感知：未配置时 httpFetch === globalThis.fetch，行为与从前一致。
    // 注意传 url，让 https 请求只匹配 HTTPS 代理（见 http-client 的说明）。
    const url = cfg.baseUrl + '/systemone';
    const { fetch: httpFetch, proxyUrl } = await createHttpClient({ proxyUrl: cfg.proxyUrl, url });
    if (proxyUrl) {
      // 走代理时要留出链路延迟，超时相应放宽
      timeoutMs = Math.max(timeoutMs, cfg.timeoutMs * 2);
    }

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const t0 = Date.now();
      try {
        const resp = await httpFetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
          body: JSON.stringify({ state, model: cfg.model, questions }),
          signal: controller.signal
        });

        if (resp.status === 429 || resp.status === 529) {
          const text = await resp.text().catch(() => '');
          lastErr = new JeVError('RATE_LIMIT', `JEV ${resp.status}（限流/过载）`, text.slice(0, 200));
          onCall({
            journeyId, taskId, encounterId, operationId, operationKind: opName, attempt,
            kind: opName, provider: 'typesafe', model: cfg.model, usage: null,
            latencyMs: Date.now() - t0, status: 'error', error: lastErr.message, now: t
          });
          if (attempt < maxAttempts) {
            await new Promise(r => setTimeout(r, attempt * 2000));
            continue;
          }
          return { available: false, reason: 'RATE_LIMIT', error: lastErr };
        }

        if (!resp.ok) {
          const text = await resp.text().catch(() => '');
          const code = resp.status === 401 ? 'AUTH' : (resp.status === 422 ? 'VALIDATION' : 'HTTP');
          lastErr = new JeVError(code, `JEV ${resp.status}: ${text.slice(0, 200)}`);
          onCall({
            journeyId, taskId, encounterId, operationId, operationKind: opName, attempt,
            kind: opName, provider: 'typesafe', model: cfg.model, usage: null,
            latencyMs: Date.now() - t0, status: 'error', error: lastErr.message, now: t
          });
          return { available: false, reason: code, error: lastErr };
        }

        const data = await resp.json();
        const answers = data.answers || {};
        for (const id of questionIds) {
          validateAnswer(id, questions[id], answers[id]);
        }
        const usage = data.usage || { input_tokens: 0, output_tokens: 0 };
        const model = data.model || cfg.model;
        const latencyMs = Date.now() - t0;
        onCall({
          journeyId, taskId, encounterId, operationId, operationKind: opName, attempt,
          kind: opName, provider: 'typesafe', model, usage, latencyMs, status: 'ok', error: null, now: t
        });
        return { available: true, answers, usage, model, latencyMs };
      } catch (err) {
        if (err instanceof JeVError) {
          if (err.code === 'RATE_LIMIT' && attempt < maxAttempts) continue;
          return { available: false, reason: err.code, error: err };
        }
        lastErr = err.name === 'AbortError'
          ? new JeVError('TIMEOUT', `JEV 请求超时（${timeoutMs}ms）`)
          : new JeVError('NETWORK', `JEV 网络错误: ${err.message}`);
        onCall({
          journeyId, taskId, encounterId, operationId, operationKind: opName, attempt,
          kind: opName, provider: 'typesafe', model: cfg.model, usage: null,
          latencyMs: Date.now() - t0, status: 'error', error: lastErr.message, now: t
        });
        if (attempt < maxAttempts) continue;
        return { available: false, reason: lastErr.code, error: lastErr };
      } finally {
        clearTimeout(timer);
      }
    }
    return { available: false, reason: lastErr?.code || 'HTTP', error: lastErr };
  }

  return { judge, isEnabled: isJeVEnabled, getConfig };
}

module.exports = { createJev, isJeVEnabled, getConfig, JeVError };
