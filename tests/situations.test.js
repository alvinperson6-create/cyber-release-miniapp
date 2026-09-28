// 离线边界测试：处境识别（分句、四值 stance、证据恢复、降级路径）
const { test } = require('node:test');
const assert = require('node:assert');
const { splitSentences, recognizeSituations, buildSituationQuestions } = require('../server/situations');

test('splitSentences：多句切分并编号', () => {
  const s = splitSentences('每天都干不完，我真的想歇一下。老板还总在下班前找我！');
  assert.equal(s.length, 2);
  assert.equal(s[0].id, 's1');
  assert.match(s[1].text, /下班前找我/);
});

test('splitSentences：单句/空输入', () => {
  assert.deepEqual(splitSentences('就是烦'), [{ id: 's1', text: '就是烦' }]);
  assert.deepEqual(splitSentences(''), []);
  assert.deepEqual(splitSentences(null), []);
});

test('buildSituationQuestions：每处境两问、证据选项=句段ID+none', () => {
  const sentences = splitSentences('每天都干不完。想歇一下。');
  const { questions } = buildSituationQuestions(sentences);
  assert.equal(Object.keys(questions).length, 16); // 8 处境 × stance/evidence
  const ev = questions['task_overload__evidence'];
  assert.deepEqual(Object.keys(ev.criteria).sort(), ['none', 's1', 's2']);
});

test('recognizeSituations：stub 判断器返回 supported → 证据句恢复原文', async () => {
  const stub = async (state, questions) => {
    const answers = {};
    for (const [id, q] of Object.entries(questions)) {
      if (id === 'task_overload__stance') {
        answers[id] = { type: 'choice', choice: 'supported', confidence: 0.9, probabilities: {} };
      } else if (id === 'task_overload__evidence') {
        answers[id] = { type: 'choice', choice: 's1', probabilities: {} };
      } else if (id.endsWith('__stance')) {
        answers[id] = { type: 'choice', choice: 'unexpressed', confidence: 0.9, probabilities: {} };
      } else {
        answers[id] = { type: 'choice', choice: 'none', probabilities: {} };
      }
    }
    return { answers, usage: { input_tokens: 10, output_tokens: 2 }, model: 'stub', latencyMs: 1 };
  };
  const r = await recognizeSituations('每天都干不完，我真的想歇一下。', { deps: { jevJudge: stub }, thresholds: { situationMinConfidence: 0.45 } });
  assert.equal(r.degraded, false);
  assert.equal(r.supported.length, 1);
  assert.equal(r.supported[0].id, 'task_overload');
  assert.equal(r.supported[0].evidenceText, '每天都干不完，我真的想歇一下。');
  assert.equal(r.judge.model, 'stub');
});

test('recognizeSituations：低置信度 supported 不可用（阈值拦截）', async () => {
  const stub = async (state, questions) => {
    const answers = {};
    for (const [id, q] of Object.entries(questions)) {
      if (id === 'task_overload__stance') answers[id] = { type: 'choice', choice: 'supported', confidence: 0.3, probabilities: {} };
      else if (id.endsWith('__stance')) answers[id] = { type: 'choice', choice: 'unexpressed', confidence: 0.9, probabilities: {} };
      else answers[id] = { type: 'choice', choice: 'none', probabilities: {} };
    }
    return { answers, usage: {}, model: 'stub', latencyMs: 1 };
  };
  const r = await recognizeSituations('累', { deps: { jevJudge: stub }, thresholds: { situationMinConfidence: 0.45 } });
  assert.equal(r.supported.length, 0); // 0.3 < 0.45：不采信
  assert.equal(r.degraded, false);
});

test('recognizeSituations：判断器抛错 → 明确降级，不把未知当否', async () => {
  const stub = async () => { const e = new Error('boom'); e.code = 'TIMEOUT'; throw e; };
  const r = await recognizeSituations('每天都干不完', { deps: { jevJudge: stub } });
  assert.equal(r.degraded, true);
  assert.equal(r.degradeReason, 'situation_judge_TIMEOUT');
  assert.deepEqual(r.supported, []);
});

test('recognizeSituations：反话防护说明已进入题目（讽刺正面词不算积极）', () => {
  const sentences = splitSentences('呵呵，真是太开心了。');
  const { questions } = buildSituationQuestions(sentences);
  assert.match(questions['positive_anticipation__stance'].instructions, /反话|讽刺/);
});
