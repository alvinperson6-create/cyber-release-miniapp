// 离线边界测试：统一编排核心（预算、修复、降级、状态语义）
// 控制手段：环境变量（开关/预算）+ 替换 ai.chatCompletion + 注入 deps.jevJudge；全程不触网
const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const ai = require('../server/ai');
const { createStoryForRecord } = require('../server/story-pipeline');
const { POSITIVE_CHECKS, NEGATIVE_CHECKS } = require('../server/acceptance');
const { makeDestinyJson } = require('./helpers/destiny-fixture');

const ENV_KEYS = ['AI_API_KEY', 'JEV_API_KEY', 'JEV_ENABLED', 'STORY_REPAIR_MAX'];
const savedEnv = {};
beforeEach(() => {
  for (const k of ENV_KEYS) {
    if (!(k in savedEnv)) savedEnv[k] = process.env[k];
    process.env.AI_API_KEY = 'test-key';
    process.env.JEV_API_KEY = 'test-key';
    process.env.JEV_ENABLED = '1';
    delete process.env.STORY_REPAIR_MAX;
  }
});

// ---- stub 工厂 ----

// 情境判断答案：task_overload=supported(s1)，其余 unexpressed/none
function situationAnswers(questions) {
  const answers = {};
  for (const [id] of Object.entries(questions)) {
    if (id === 'task_overload__stance') answers[id] = { type: 'choice', choice: 'supported', confidence: 0.9, probabilities: {} };
    else if (id === 'task_overload__evidence') answers[id] = { type: 'choice', choice: 's1', probabilities: {} };
    else if (id.endsWith('__stance')) answers[id] = { type: 'choice', choice: 'unexpressed', confidence: 0.9, probabilities: {} };
    else answers[id] = { type: 'choice', choice: 'none', probabilities: {} };
  }
  return answers;
}

// 语义 noul 答案：正向 pass/high，反向 pass/low
function semanticAnswers(questions, { pos = 0.9, neg = 0.1, overrides = {} } = {}) {
  const answers = {};
  for (const id of Object.keys(questions)) {
    if (POSITIVE_CHECKS.some(c => c.id === id)) answers[id] = { type: 'noul', noul: overrides[id] ?? pos };
    else if (NEGATIVE_CHECKS.some(c => c.id === id)) answers[id] = { type: 'noul', noul: overrides[id] ?? neg };
    else answers[id] = { type: 'noul', noul: overrides[id] ?? neg };
  }
  return answers;
}

function makeJudgeStub({ semanticPlan }) {
  // semanticPlan: 数组，每次语义调用依次取一个配置
  let semanticCalls = 0;
  return async (state, questions) => {
    if ('task_overload__stance' in questions) {
      return { answers: situationAnswers(questions), usage: { input_tokens: 10, output_tokens: 2 }, model: 'stub', latencyMs: 1 };
    }
    const plan = semanticPlan[Math.min(semanticCalls, semanticPlan.length - 1)];
    semanticCalls += 1;
    if (plan === 'throw') { const e = new Error('x'); e.code = 'TIMEOUT'; throw e; }
    return { answers: semanticAnswers(questions, plan || {}), usage: { input_tokens: 10, output_tokens: 2 }, model: 'stub', latencyMs: 1 };
  };
}

function chatStubResponses(responses) {
  const calls = [];
  const stub = async (messages, options) => {
    const i = Math.min(calls.length, responses.length - 1);
    calls.push({ systemHead: messages[0].content.slice(0, 40), options });
    const content = typeof responses[i] === 'function' ? responses[i](calls.length) : responses[i];
    return { content, usage: { input_tokens: 100, output_tokens: 500 }, model: 'stub-text', finishReason: 'stop', latencyMs: 7 };
  };
  stub.calls = calls;
  return stub;
}

const BASE = { feeling: '每天都干不完，我真的想歇一下', creature: 'koi', water: 'xihu', replyTimeLabel: '一天后' };
const goodJson = () => JSON.stringify(makeDestinyJson());

test('编排：AI 未配置 → template_fallback', async () => {
  process.env.AI_API_KEY = '';
  ai.chatCompletion = async () => { throw new Error('不应被调用'); };
  const { destiny, meta } = await createStoryForRecord(BASE);
  assert.equal(meta.status, 'template_fallback');
  assert.equal(destiny.segments.length, 4);
});

test('编排：JEV 开关关闭 → legacy，不产生判断调用', async () => {
  process.env.JEV_ENABLED = '0';
  const stub = chatStubResponses([goodJson()]);
  ai.chatCompletion = stub;
  const { destiny, meta } = await createStoryForRecord(BASE);
  assert.equal(meta.status, 'legacy');
  assert.equal(destiny.segments.length, 4);
  assert.equal(meta.generation.calls, 1);
  assert.equal(meta.judging.calls, 0);
  assert.ok(stub.calls[0].systemHead.startsWith('你是')); // 无契约前缀
});

test('编排：JEV 关闭且生成失败 → template_fallback（不伪装成功）', async () => {
  process.env.JEV_ENABLED = '0';
  ai.chatCompletion = async () => { throw new Error('500'); };
  const { meta } = await createStoryForRecord(BASE);
  assert.equal(meta.status, 'template_fallback');
  assert.ok(meta.notes.some(n => n.includes('旧路径生成失败')));
});

test('编排：一次通过 → accepted，生成1次、判断2次', async () => {
  const stub = chatStubResponses([goodJson()]);
  ai.chatCompletion = stub;
  const { destiny, meta } = await createStoryForRecord({ ...BASE, deps: { jevJudge: makeJudgeStub({ semanticPlan: [{}] }) } });
  assert.equal(meta.status, 'accepted');
  assert.equal(destiny.segments.length, 4);
  assert.equal(meta.generation.calls, 1);
  assert.equal(meta.judging.calls, 2); // 处境 + 语义
  assert.equal(meta.contract.judgeStatus, 'ok');
  assert.deepEqual(meta.contract.supportedCount >= 0, true);
  // 契约注入了生成 prompt
  assert.ok(stub.calls[0].systemHead.startsWith('【创作契约】'));
});

test('编排：语义失败→定向修复→复查通过 → repaired，生成2次（预算内）', async () => {
  const good2 = JSON.stringify(makeDestinyJson({ textPrefix: '修订版' }));
  const stub = chatStubResponses([goodJson(), good2]);
  ai.chatCompletion = stub;
  const { destiny, meta } = await createStoryForRecord({ ...BASE, deps: { jevJudge: makeJudgeStub({ semanticPlan: [{ overrides: { causal_2_3: 0.1 } }, {}] }) } });
  assert.equal(meta.status, 'repaired');
  assert.equal(meta.generation.calls, 2);
  assert.equal(meta.repairs.filter(r => r.kind === 'semantic' && r.result !== 'applied').length, 0);
  assert.match(destiny.segments[0].text, /修订版/); // 采用修复后的版本
  // 修复 prompt 是定向的：包含失败维度说明
  assert.ok(stub.calls[1].systemHead.includes('修订编辑'));
});

test('编排：修复后仍失败 → degraded（如实标记，不冒充通过）', async () => {
  const stub = chatStubResponses([goodJson(), goodJson()]);
  ai.chatCompletion = stub;
  const { meta } = await createStoryForRecord({ ...BASE, deps: { jevJudge: makeJudgeStub({ semanticPlan: [{ overrides: { behavior_change: 0.1 } }, { overrides: { behavior_change: 0.1 } }] }) } });
  assert.equal(meta.status, 'degraded');
  assert.equal(meta.generation.calls, 2);
  assert.ok(meta.semantics.failures.some(f => f.id === 'behavior_change'));
  assert.ok(meta.notes.some(n => n.includes('仍有失败维度')));
});

test('编排：语义判断不可用 → judge_unavailable，保留已生成版本', async () => {
  const stub = chatStubResponses([goodJson()]);
  ai.chatCompletion = stub;
  const { destiny, meta } = await createStoryForRecord({ ...BASE, deps: { jevJudge: makeJudgeStub({ semanticPlan: ['throw'] }) } });
  assert.equal(meta.status, 'judge_unavailable');
  assert.equal(destiny.segments.length, 4);
  assert.ok(meta.notes.some(n => n.includes('语义验收不可用')));
});

test('编排：结构修复成功（3集→4集）→ repaired', async () => {
  const threeSegs = JSON.stringify(makeDestinyJson()).replace(/"segments":\s*\[/, '"segments":[')
    .replace(/\}\s*\]\s*\}\s*$/, '}] }');
  const broken = (() => {
    const d = makeDestinyJson();
    d.segments = d.segments.slice(0, 3);
    return JSON.stringify(d);
  })();
  const stub = chatStubResponses([broken, goodJson()]);
  ai.chatCompletion = stub;
  const { meta } = await createStoryForRecord({ ...BASE, deps: { jevJudge: makeJudgeStub({ semanticPlan: [{}] }) } });
  assert.equal(meta.status, 'repaired');
  assert.equal(meta.generation.calls, 2);
  assert.ok(meta.repairs.some(r => r.kind === 'structure' && r.result === 'applied'));
});

test('编排：完全无法解析且修复无效 → degraded + 模板兜底', async () => {
  const stub = chatStubResponses(['不是JSON', '还不是JSON']);
  ai.chatCompletion = stub;
  const { destiny, meta } = await createStoryForRecord({ ...BASE, deps: { jevJudge: makeJudgeStub({ semanticPlan: [] }) } });
  assert.equal(meta.status, 'degraded');
  assert.equal(destiny.segments.length, 4); // 模板
  assert.ok(meta.notes.some(n => n.includes('结构修复预算')));
});

test('编排：STORY_REPAIR_MAX=0 → 语义失败也不修复，generation.calls=1', async () => {
  process.env.STORY_REPAIR_MAX = '0';
  const stub = chatStubResponses([goodJson()]);
  ai.chatCompletion = stub;
  const { meta } = await createStoryForRecord({ ...BASE, deps: { jevJudge: makeJudgeStub({ semanticPlan: [{ overrides: { causal_3_4: 0.1 } }] }) } });
  assert.equal(meta.status, 'degraded');
  assert.equal(meta.generation.calls, 1);
  assert.equal(meta.repairs.length, 0);
});

test('编排：生成抛错（网络）→ 结构修复通道 → 仍失败 → degraded+模板', async () => {
  ai.chatCompletion = async () => { throw new Error('ECONNREFUSED'); };
  const { destiny, meta } = await createStoryForRecord({ ...BASE, deps: { jevJudge: makeJudgeStub({ semanticPlan: [] }) } });
  assert.equal(meta.status, 'degraded');
  assert.equal(destiny.segments.length, 4);
});

test('编排：处境判断降级时契约如实标记，链路继续', async () => {
  const judgeStub = async (state, questions) => {
    if ('task_overload__stance' in questions) { const e = new Error('x'); e.code = 'AUTH'; throw e; }
    return { answers: semanticAnswers(questions, {}), usage: {}, model: 'stub', latencyMs: 1 };
  };
  const stub = chatStubResponses([goodJson()]);
  ai.chatCompletion = stub;
  const { meta } = await createStoryForRecord({ ...BASE, deps: { jevJudge: judgeStub } });
  assert.equal(meta.situation.degraded, true);
  assert.equal(meta.contract.judgeStatus, 'degraded');
  assert.equal(meta.status, 'accepted'); // 语义验收通过即接受；处境降级单独记录
});
