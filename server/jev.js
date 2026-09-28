// 赛博放生 · JEV 判断适配器（typesafe.ai SystemOne API）
//
// 职责边界（见 docs/jev-design.md）：
// - 只做有限选项(Choice)/量表(Score)/是非命题(Noul)判断，不做自由文本生成
// - 同一请求中的问题彼此独立，不能让第二题读取第一题答案；代码负责组合答案
// - 输入仅支持文本；官方文档说明 CJK 准确率低于英文，阈值需按本项目样本校准
// - Noul 没有单独的 confidence 字段；confidence 不是事实正确性保证
//
// 环境变量：JEV_API_KEY / JEV_BASE_URL(默认 https://api.typesafe.ai/v1) /
//          JEV_MODEL(默认 jev-latest) / JEV_TIMEOUT_MS(默认 30000)

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
    timeoutMs: parseInt(process.env.JEV_TIMEOUT_MS || '30000', 10) || 30000
  };
}

function isJeVEnabled() {
  return !!getConfig().apiKey && process.env.JEV_ENABLED !== '0';
}

// 校验单条答案结构：缺字段/类型不符视为 FORMAT 失败，绝不能把解析失败伪装成判断通过
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
 * 发起一次 JEV 判断请求。
 * @param {string|object|array} state 判断材料（仅文本）
 * @param {Record<string, {type:'noul'|'choice'|'score', instructions:string, criteria?:object}>} questions
 * @param {{maxAttempts?:number}} opts 429/529 时的额外退避重试次数（默认 1 次重试）
 * @returns {{answers:object, usage:object, model:string, latencyMs:number}}
 */
async function jevJudge(state, questions, opts = {}) {
  const cfg = getConfig();
  if (!cfg.apiKey) throw new JeVError('NO_CREDENTIAL', '缺少 JEV_API_KEY，无法进行语义判断');
  const questionIds = Object.keys(questions);
  if (!questionIds.length) throw new JeVError('VALIDATION', 'questions 不能为空');

  const maxAttempts = Math.max(1, opts.maxAttempts ?? 2);
  let lastErr = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
    const t0 = Date.now();
    try {
      const resp = await fetch(cfg.baseUrl + '/systemone', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${cfg.apiKey}`
        },
        body: JSON.stringify({ state, model: cfg.model, questions }),
        signal: controller.signal
      });

      if (resp.status === 429 || resp.status === 529) {
        const text = await resp.text().catch(() => '');
        lastErr = new JeVError('RATE_LIMIT', `JEV ${resp.status}（限流/过载）`, text.slice(0, 200));
        if (attempt < maxAttempts) {
          await new Promise(r => setTimeout(r, attempt * 2000));
          continue;
        }
        throw lastErr;
      }

      if (!resp.ok) {
        const text = await resp.text().catch(() => '');
        const code = resp.status === 401 ? 'AUTH'
          : resp.status === 422 ? 'VALIDATION'
          : 'HTTP';
        throw new JeVError(code, `JEV ${resp.status}: ${text.slice(0, 200)}`);
      }

      const data = await resp.json();
      const answers = data.answers || {};
      for (const id of questionIds) {
        validateAnswer(id, questions[id], answers[id]);
      }
      return {
        answers,
        usage: data.usage || { input_tokens: 0, output_tokens: 0 },
        model: data.model || cfg.model,
        latencyMs: Date.now() - t0
      };
    } catch (err) {
      if (err instanceof JeVError) {
        if (err.code === 'RATE_LIMIT' && attempt < maxAttempts) continue;
        throw err;
      }
      if (err.name === 'AbortError') {
        lastErr = new JeVError('TIMEOUT', `JEV 请求超时（${cfg.timeoutMs}ms）`);
      } else {
        lastErr = new JeVError('NETWORK', `JEV 网络错误: ${err.message}`);
      }
      if (attempt < maxAttempts) continue;
      throw lastErr;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr || new JeVError('HTTP', 'JEV 请求未返回');
}

module.exports = { jevJudge, isJeVEnabled, getConfig, JeVError };
