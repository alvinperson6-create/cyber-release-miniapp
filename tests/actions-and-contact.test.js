// 行动数量契约与结算检查动机回归（2026-10-04 最小核查）
// 覆盖：validateProposal 数量边界；2/4 个行动走完整 提案→JEV 决策→结算；
// JEV Choice 动态包含全部行动；jev_settlement_check 的 state 携带本程动机档案。
const { test } = require('node:test');
const assert = require('node:assert');
const { createWorld, proposalJson } = require('./helpers/world');
const director = require('../server/director');

function actionsN(n) {
  return Array.from({ length: n }, (_, i) => ({ id: `a${i + 1}`, label: `行动${i + 1}`, cost: `真实代价${i + 1}` }));
}

// ---------- 程序数量校验（3 个动作的全路径由既有套件覆盖） ----------
test('validateProposal：2 与 4 个动作通过；1 与 5 个被拒', () => {
  const mk = (n) => proposalJson({ actions: actionsN(n) });
  assert.equal(director.validateProposal(mk(2)).ok, true);
  assert.equal(director.validateProposal(mk(4)).ok, true);
  assert.equal(director.validateProposal(mk(1)).ok, false);
  assert.equal(director.validateProposal(mk(5)).ok, false);
});

// ---------- 全路径：N 个行动 → JEV 决策 → 结算 ----------
function pathWorld(n, pickId) {
  const seenCriteria = [];
  const world = createWorld({
    tag: `act${n}`,
    llm: {
      opening: () => ({ goal: '把每件帮完的忙都记在小贝壳上', encounter: proposalJson({ title: '多选项遭遇', actions: actionsN(n) }) }),
      proposal: () => proposalJson({ title: '下一遭遇', actions: actionsN(n) }),
      settlement: () => ({
        narrative: '它按自己的选择做了，事情有了结果，它继续往前游。',
        facts: [{ kind: 'consequence', content: '一个后果落账' }],
        mechanism_card: { pressure: 'p', dilemma: 'd', choice_cost: 'c', lasting_consequence: 'l' }
      }),
      signal: () => ({ text: '一个简短的信号内容。' }),
      letter: () => ({ title: '信', text: '这是信的正文，只讲已经发生的事。' })
    },
    jev: {
      decide: (state, questions) => {
        seenCriteria.push(Object.keys(questions.action.criteria));
        return pickId;
      },
      contact: ['continue', 'final_letter']
    }
  });
  return { world, seenCriteria };
}

test('2 个行动：提案→JEV 决策→结算 走通，Choice 动态含全部行动', async () => {
  const { world, seenCriteria } = pathWorld(2, 'a2');
  const r = world.orchestrator.startJourney({ ownerKey: 'o1', species: 'koi', water: 'xihu', feeling: '任务太多', tone: 'balanced' });
  await world.drain(60, { stopWhen: () => world.db.getLatestEncounter(r.journey.id)?.status === 'resolved' });
  const enc = world.db.getEncounter(world.db.getLatestEncounter(r.journey.id).id);
  assert.equal(enc.status, 'resolved');
  assert.equal(enc.chosenAction, 'a2');
  assert.equal(enc.decisionSource, 'jev');
  assert.deepEqual(seenCriteria[0].filter(k => /^a\d+$/.test(k)).sort(), ['a1', 'a2'], 'JEV criteria 含全部行动');
});

test('4 个行动：提案→JEV 决策→结算 走通，Choice 动态含全部行动', async () => {
  const { world, seenCriteria } = pathWorld(4, 'a4');
  const r = world.orchestrator.startJourney({ ownerKey: 'o1', species: 'turtle', water: 'baikal', feeling: '太慢了', tone: 'balanced' });
  await world.drain(60, { stopWhen: () => world.db.getLatestEncounter(r.journey.id)?.status === 'resolved' });
  const enc = world.db.getEncounter(world.db.getLatestEncounter(r.journey.id).id);
  assert.equal(enc.status, 'resolved');
  assert.equal(enc.chosenAction, 'a4');
  assert.equal(enc.decisionSource, 'jev');
  assert.deepEqual(seenCriteria[0].filter(k => /^a\d+$/.test(k)).sort(), ['a1', 'a2', 'a3', 'a4'], 'JEV criteria 含全部行动');
});

// ---------- 结算检查携带持续动机 ----------
test('jev_settlement_check 的 state 显式携带本程动机档案（contact 与 consistency 同请求、两题独立）', async () => {
  const world = createWorld({
    tag: 'setmot',
    llm: {
      opening: () => ({ goal: '学会量力而行地帮忙', encounter: proposalJson({ title: '螃蟹的代班请求' }) }),
      proposal: () => proposalJson({ title: '下一遭遇' }),
      settlement: () => ({
        narrative: '它答应了代班，累但被需要，班次翻倍。',
        facts: [{ kind: 'relationship', content: '螃蟹成了它的朋友' }],
        mechanism_card: { pressure: '代班请求', dilemma: '接不接', choice_cost: '睡眠', lasting_consequence: '成了最好说话的那个' }
      }),
      signal: () => ({ text: '螃蟹想让我代一晚班，我有点犹豫。' }),
      letter: () => ({ title: '第一夜', text: '我替螃蟹值了一晚班，鳍都是僵的。' })
    },
    jev: { decide: 'a1', contact: 'continue' }
  });
  const FEELING = '最近项目天天催进度，谁找我帮忙都不好意思拒绝，自己的活全被挤到最后';
  const r = world.orchestrator.startJourney({ ownerKey: 'o1', species: 'koi', water: 'xihu', feeling: FEELING, tone: 'balanced' });
  await world.drain(60, { stopWhen: () => world.db.getLatestEncounter(r.journey.id)?.status === 'resolved' });
  const call = world.jevState.calls.filter(c => c.q.includes('action_consistency') && c.q.includes('contact')).pop();
  assert.ok(call, 'settlement check 已发生（两题同请求）');
  assert.ok(call.state.includes('本程动机档案'), 'state 含动机档案字段');
  assert.ok(call.state.includes(FEELING), 'state 含动机原话');
  assert.ok(call.state.includes('最近任务过量') || call.state.includes('处境') || call.state.includes('原话'), '含识别结构');
  // 决策输入也持续携带（既有行为回归）
  const decide = world.jevState.calls.filter(c => c.q.includes('action')).pop();
  assert.ok(decide.state.includes('本程动机档案') && decide.state.includes(FEELING));
});

// ---------- 故事线第一人称契约 ----------
test('提示词契约：开局/提案/重提案的 situation 与结算 narrative 均要求第一人称「我」', () => {
  const journey = { species: 'koi', water: 'xihu', tone: 'balanced', goal: 'g', feeling: 'f' };
  const motivation = { rawText: '原话', items: [], status: 'recognized', version: 1 };
  const enc = {
    proposal: proposalJson(),
    chosenAction: 'a1'
  };
  const opening = director.buildOpeningMessages({ journey, motivation, now: 0 });
  assert.ok(opening.system.includes('第一人称「我」叙述'), 'opening situation 第一人称');

  const proposal = director.buildProposalMessages({ journey, motivation, facts: [], recentCards: [], openThreads: [], lastSettlement: null, now: 0 });
  assert.ok(proposal.system.includes('situation 用生物第一人称「我」叙述'), 'proposal 第一人称');

  const reproposal = director.buildReproposalMessages({ journey, facts: [], recentCards: [], rejectedProposal: proposalJson(), now: 0 });
  assert.ok(reproposal.system.includes('situation 用生物第一人称「我」叙述'), 'reproposal 第一人称');

  const settlement = director.buildSettlementMessages({ journey, encounter: enc, facts: [], now: 0 });
  assert.ok(settlement.system.includes('以生物第一人称「我」讲述'), 'settlement narrative 第一人称');
});
