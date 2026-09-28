// 离线边界测试：结构校验、阈值决策、语义验收（stub 判断器）、降级路径
const { test } = require('node:test');
const assert = require('node:assert');
const { checkStructure, checkSemantics, decideCheck, POSITIVE_CHECKS, NEGATIVE_CHECKS } = require('../server/acceptance');
const { makeDestinyJson } = require('./helpers/destiny-fixture');

const good = () => {
  const d = makeDestinyJson();
  return d;
};

test('结构校验：完整四集通过', () => {
  const r = checkStructure(good());
  assert.equal(r.pass, true, JSON.stringify(r.issues));
});

test('结构校验：缺集/空文本/重复内容/缺字段均拦截', () => {
  const d = good();
  d.segments = d.segments.slice(0, 3);
  assert.equal(checkStructure(d).pass, false);

  const d2 = good();
  d2.segments[2].text = '';
  assert.equal(checkStructure(d2).pass, false);

  const d3 = good();
  d3.segments.forEach(s => { s.text = '完全一样的内容完全一样的内容完全一样的内容完全一样的内容'; });
  assert.equal(checkStructure(d3).pass, false);

  const d4 = good();
  d4.location = '';
  assert.equal(checkStructure(d4).pass, false);

  const d5 = good();
  d5.visualForImage = { style: 'x' };
  assert.equal(checkStructure(d5).pass, false);

  assert.equal(checkStructure(null).pass, false);
});

test('阈值决策：正向 pass/weak/fail 与反向镜像（确定性，无模型裁量）', () => {
  const posDef = { id: 'causal_1_2', dim: '因果链1→2' };
  assert.equal(decideCheck(posDef, 0.7, { acceptMin: 0.6, failMin: 0.4 }).verdict, 'pass');
  assert.equal(decideCheck(posDef, 0.5, { acceptMin: 0.6, failMin: 0.4 }).verdict, 'weak');
  assert.equal(decideCheck(posDef, 0.3, { acceptMin: 0.6, failMin: 0.4 }).verdict, 'fail');

  const negDef = { id: 'fabricated_user_facts', dim: '虚构用户事实' };
  assert.equal(decideCheck(negDef, 0.1, { failMax: 0.4, alarmMin: 0.6 }).verdict, 'pass');
  assert.equal(decideCheck(negDef, 0.5, { failMax: 0.4, alarmMin: 0.6 }).verdict, 'weak');
  assert.equal(decideCheck(negDef, 0.9, { failMax: 0.4, alarmMin: 0.6 }).verdict, 'fail');

  assert.equal(decideCheck(posDef, null, { acceptMin: 0.6, failMin: 0.4 }).verdict, 'fail');
});

function stubJudgeWith(noulMap) {
  return async (state, questions) => {
    const answers = {};
    for (const id of Object.keys(questions)) {
      if (!(id in noulMap)) throw new Error(`stub 未定义 ${id}`);
      answers[id] = { type: 'noul', noul: noulMap[id] };
    }
    return { answers, usage: { input_tokens: 100, output_tokens: 20 }, model: 'stub', latencyMs: 5 };
  };
}

test('语义验收：全部通过 → 无 failures，judge 元数据在案', async () => {
  const noulMap = {};
  POSITIVE_CHECKS.forEach(c => { noulMap[c.id] = 0.9; });
  NEGATIVE_CHECKS.forEach(c => { noulMap[c.id] = 0.1; });
  const r = await checkSemantics({ feeling: '累', situationResult: null, destiny: good(), deps: { jevJudge: stubJudgeWith(noulMap) } });
  assert.equal(r.degraded, false);
  assert.equal(r.failures.length, 0);
  assert.equal(r.checks.length, POSITIVE_CHECKS.length + NEGATIVE_CHECKS.length);
  assert.equal(r.judge.model, 'stub');
});

test('语义验收：因果反向 + 编造事实 → 命中对应失败维度', async () => {
  const noulMap = {};
  POSITIVE_CHECKS.forEach(c => { noulMap[c.id] = 0.9; });
  NEGATIVE_CHECKS.forEach(c => { noulMap[c.id] = 0.1; });
  noulMap.causal_2_3 = 0.2;            // 因果反过来
  noulMap.fabricated_user_facts = 0.95; // 擅自编公司/人名
  const r = await checkSemantics({ feeling: '累', situationResult: null, destiny: good(), deps: { jevJudge: stubJudgeWith(noulMap) } });
  const dims = r.failures.map(f => f.id);
  assert.ok(dims.includes('causal_2_3'));
  assert.ok(dims.includes('fabricated_user_facts'));
  assert.equal(r.failures.length, 2);
});

test('语义验收：地点矛盾 / 图文冲突可被反向检查捕获', async () => {
  const noulMap = {};
  POSITIVE_CHECKS.forEach(c => { noulMap[c.id] = 0.9; });
  NEGATIVE_CHECKS.forEach(c => { noulMap[c.id] = 0.1; });
  noulMap.reply_visual_conflict = 0.9;
  const r = await checkSemantics({ feeling: '累', situationResult: null, destiny: good(), deps: { jevJudge: stubJudgeWith(noulMap) } });
  assert.ok(r.failures.map(f => f.id).includes('reply_visual_conflict'));
});

test('语义验收：weak（中间带）既不放行也不拦截，单独记录', async () => {
  const noulMap = {};
  POSITIVE_CHECKS.forEach(c => { noulMap[c.id] = 0.5; });
  NEGATIVE_CHECKS.forEach(c => { noulMap[c.id] = 0.5; });
  const r = await checkSemantics({ feeling: '累', situationResult: null, destiny: good(), deps: { jevJudge: stubJudgeWith(noulMap) } });
  assert.equal(r.failures.length, 0);
  assert.equal(r.weak.length, POSITIVE_CHECKS.length + NEGATIVE_CHECKS.length);
});

test('语义验收：判断器超时 → degraded，绝不记成通过', async () => {
  const stub = async () => { const e = new Error('t'); e.code = 'TIMEOUT'; throw e; };
  const r = await checkSemantics({ feeling: '累', situationResult: null, destiny: good(), deps: { jevJudge: stub } });
  assert.equal(r.degraded, true);
  assert.equal(r.degradeReason, 'semantic_judge_TIMEOUT');
  assert.deepEqual(r.failures, []);
});

test('语义验收：事件账本问题仅在有 journeyContext 时出现', async () => {
  const noulMap = {};
  POSITIVE_CHECKS.forEach(c => { noulMap[c.id] = 0.9; });
  NEGATIVE_CHECKS.forEach(c => { noulMap[c.id] = 0.1; });
  noulMap.ledger_consistency = 0.95;
  const jc = { ledgerSummary: '1. 螃蟹请代班 → 拒绝' };
  const withLedger = await checkSemantics({ feeling: '累', situationResult: null, destiny: good(), journeyContext: jc, deps: { jevJudge: stubJudgeWith(noulMap) } });
  assert.ok(withLedger.failures.map(f => f.id).includes('ledger_consistency'));
  const without = await checkSemantics({ feeling: '累', situationResult: null, destiny: good(), deps: { jevJudge: stubJudgeWith(noulMap) } });
  assert.ok(!without.checks.some(c => c.id === 'ledger_consistency'));
});
