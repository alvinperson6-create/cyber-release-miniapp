// 离线边界测试：创作契约（确定性编译、证据引用、降级标记、事件账本注入）
const { test } = require('node:test');
const assert = require('node:assert');
const { buildCreationContract, TENDENCY_BY_SITUATION } = require('../server/contract');

const situationOk = {
  contractVersion: 'situation-contract-v1',
  feeling: '每天都干不完，我真的想歇一下',
  sentences: [{ id: 's1', text: '每天都干不完，我真的想歇一下' }],
  items: [
    { id: 'task_overload', label: '任务过量', stance: 'supported', confidence: 0.9, usable: true, evidenceText: '每天都干不完，我真的想歇一下' },
    { id: 'positive_anticipation', label: '积极期待或喜悦', stance: 'unexpressed', confidence: 0.8, usable: false, evidenceText: null }
  ],
  supported: [{ id: 'task_overload', label: '任务过量', evidence: '每天都干不完，我真的想歇一下' }],
  degraded: false
};

test('契约：确定性 —— 相同输入输出完全一致', () => {
  const a = buildCreationContract({ feeling: 'X', situationResult: situationOk, creatureName: '锦鲤', waterName: '西湖', replyTimeLabel: '一天后' });
  const b = buildCreationContract({ feeling: 'X', situationResult: situationOk, creatureName: '锦鲤', waterName: '西湖', replyTimeLabel: '一天后' });
  assert.equal(a.promptText, b.promptText);
});

test('契约：包含原话、证据句、行为倾向、事实边界', () => {
  const c = buildCreationContract({ feeling: '每天都干不完，我真的想歇一下', situationResult: situationOk, creatureName: '锦鲤', waterName: '西湖', replyTimeLabel: '一天后' });
  assert.match(c.promptText, /每天都干不完，我真的想歇一下/);
  assert.match(c.promptText, /任务过量/);
  assert.match(c.promptText, /每天都干不完，我真的想歇一下/); // 证据句原文
  assert.ok(c.requiredTendencies.includes(TENDENCY_BY_SITUATION.task_overload));
  assert.match(c.promptText, /不得虚构用户未提供的事实/);
  assert.match(c.promptText, /四集因果链/);
});

test('契约：降级时明确标记判断来源，不臆测处境', () => {
  const c = buildCreationContract({ feeling: '就是烦', situationResult: { degraded: true, degradeReason: 'situation_judge_TIMEOUT', sentences: [], items: [], supported: [] }, creatureName: '乌龟', waterName: '贝加尔湖', replyTimeLabel: '三天后' });
  assert.equal(c.judgeStatus, 'degraded');
  assert.match(c.promptText, /situation_judge_TIMEOUT/);
  assert.match(c.promptText, /不要臆测具体处境/);
});

test('契约：被反驳处境写入禁写清单', () => {
  const sr = { ...situationOk, items: [...situationOk.items, { id: 'relationship_loss', label: '关系失落', stance: 'contradicted', confidence: 0.9, usable: false, evidenceText: null }], supported: situationOk.supported };
  const c = buildCreationContract({ feeling: 'X', situationResult: sr, creatureName: '锦鲤', waterName: '西湖', replyTimeLabel: '一天后' });
  assert.match(c.promptText, /关系失落/);
  assert.match(c.promptText, /禁止写成主线/);
});

test('契约：事件账本（第二阶段）注入', () => {
  const c = buildCreationContract({ feeling: 'X', situationResult: situationOk, creatureName: '锦鲤', waterName: '西湖', replyTimeLabel: '一天后', journeyContext: { ledgerSummary: '1. 螃蟹请代班 → 拒绝', tendencyNote: '用户已留言允许拒绝' } });
  assert.match(c.promptText, /事件账本/);
  assert.match(c.promptText, /螃蟹请代班 → 拒绝/);
  assert.match(c.promptText, /用户已留言允许拒绝/);
});
