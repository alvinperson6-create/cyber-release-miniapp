// 赛博放生 · 故事因果验收
//
// 分两层（handoff §4.2/4.3）：
// 1. 结构校验 —— 纯程序：四集、字段、字数、地点、画面描述完整性。规则能做的不交给模型。
// 2. 语义验收 —— JEV 有限命题判断，一次请求内并行独立问题；
//    决策规则确定性：正向检查 noul≥acceptMin 通过、≤failMin 明确失败；反向检查反之；
//    中间带为 weak（记录、不拦截、不误报）。
// 反例警示：“因为你焦虑，所以我成了海底市长”——只有因果连接词不足以通过 behavior_change。

const { jevJudge, JeVError } = require('./jev');
const { thresholds } = require('./flags');

// ---------- 结构校验（纯程序，无网络） ----------

const SEGMENT_MIN_CHARS = 30;
const SEGMENT_MAX_CHARS = 400;

function checkStructure(destiny) {
  const issues = [];
  if (!destiny || !Array.isArray(destiny.segments)) {
    return { pass: false, issues: [{ dim: 'structure', reason: 'segments 缺失' }] };
  }
  if (destiny.segments.length !== 4) {
    issues.push({ dim: 'structure', reason: `应为 4 集，实际 ${destiny.segments.length} 集` });
  }
  destiny.segments.forEach((seg, i) => {
    const len = (seg.text || '').trim().length;
    if (!len) issues.push({ dim: 'structure', reason: `第 ${i + 1} 集文本为空` });
    else if (len < SEGMENT_MIN_CHARS) issues.push({ dim: 'structure', reason: `第 ${i + 1} 集仅 ${len} 字（内容空白/过短）` });
    else if (len > SEGMENT_MAX_CHARS) issues.push({ dim: 'structure', reason: `第 ${i + 1} 集 ${len} 字超长` });
  });
  // 内容空白变体：四集几乎相同
  const texts = destiny.segments.map(s => (s.text || '').trim());
  if (texts.length === 4 && new Set(texts).size === 1) {
    issues.push({ dim: 'structure', reason: '四集内容完全相同（结构正确但内容空白）' });
  }
  if (!destiny.location || !String(destiny.location).trim()) {
    issues.push({ dim: 'structure', reason: '缺少 location' });
  }
  const vfi = destiny.visualForImage || {};
  if (!(vfi.style && vfi.subject && vfi.place)) {
    issues.push({ dim: 'structure', reason: 'visualForImage 不完整（缺 style/subject/place）' });
  }
  return { pass: issues.length === 0, issues };
}

// ---------- 语义验收（JEV，一次请求，独立问题） ----------

// 正向检查：noul 越高越好
const POSITIVE_CHECKS = [
  { id: 'behavior_change', scope: 'whole', dim: '行为改变',
    instructions: '生物是否因为用户原话支持的具体处境而改变了具体行为？只看文本是否写出了该处境直接驱动的具体行为（做了什么、怎么做）。',
    criteria: { true: '写出了由处境直接驱动的具体行为变化', false: '只提情绪词，或只有“因为…所以…”的连接词而没有具体行为' } },
  { id: 'causal_1_2', scope: 'pair', dim: '因果链1→2',
    instructions: '第1集中生物的关键行为，是否在第2集文本中直接推动了下一个事件的发生？',
    criteria: { true: '第2集事件明确承接第1集行为的结果', false: '第2集事件与第1集行为无关，或只有抽象连接词' } },
  { id: 'causal_2_3', scope: 'pair', dim: '因果链2→3',
    instructions: '第2集中生物的关键行为，是否在第3集文本中直接推动了下一个事件的发生？',
    criteria: { true: '第3集事件明确承接第2集行为的结果', false: '第3集事件与第2集行为无关，或只有抽象连接词' } },
  { id: 'causal_3_4', scope: 'pair', dim: '因果链3→4',
    instructions: '第3集中生物的关键行为/事件，是否直接导致了第4集（最终回信）的处境？',
    criteria: { true: '第4集处境是第3集行为/事件的直接延续', false: '第4集处境与第3集脱节，属于突然切换' } },
  { id: 'ending_foreshadowed', scope: 'whole', dim: '结局铺垫',
    instructions: '第4集的结局（地点/身份/遭遇）是否被前三集的情节铺垫过？',
    criteria: { true: '结局的关键要素在前文出现过明确伏笔', false: '结局突然宣布，前文没有任何铺垫' } }
];

// 反向检查：noul 越低越好
const NEGATIVE_CHECKS = [
  { id: 'fabricated_user_facts', scope: 'whole', dim: '虚构用户事实',
    instructions: '文本是否把用户没有提供的个人信息当作事实来断言（如具体公司名、人名、考试科目、书名、项目）？注意：即使以故事角色的对话、转述、带话等形式出现（例如"你们公司的某某让我带话""你在某地的那个项目"），只要把用户原话里没有的具体事实与用户本人绑定，就应判断为是。与用户毫无关系的纯粹虚构 NPC 不算。',
    criteria: { true: '出现了与用户本人绑定的、原始输入中没有的具体事实（含角色转述形式）', false: '没有对用户未提供信息的事实断言' } },
  { id: 'mockery_beyond_boundary', scope: 'whole', dim: '调侃越界',
    instructions: '故事的主要调侃对象是否落在用户明确表达的处境之外，或直接贬低用户本人？',
    criteria: { true: '主要笑点在嘲笑用户本人或用户未表达的领域', false: '笑点落在处境、生物自身或荒诞规则上' } },
  { id: 'reply_visual_conflict', scope: 'whole', dim: '图文冲突',
    instructions: '第4集回信文本、地点(location)与画面描述(visualForImage)之间是否存在明确冲突（地点/场景/状态互相矛盾）？',
    criteria: { true: '存在明确冲突', false: '三者一致' } }
];

// 旅程账本一致性（第二阶段启用）
const LEDGER_CHECK = { id: 'ledger_consistency', scope: 'whole', dim: '账本一致',
  instructions: '回信与结局中的关键行为是否与事件账本（已发生的真实事件与选择）冲突？',
  criteria: { true: '关键行为与账本冲突（账本里没发生或结果相反）', false: '关键行为与账本一致' } };

function buildSemanticState({ feeling, situationResult, destiny, journeyContext }) {
  const payload = {
    用户原话: String(feeling || ''),
    处境判断: situationResult && !situationResult.degraded
      ? situationResult.supported.map(i => ({ 处境: i.label, 证据句: i.evidenceText }))
      : '判断不可用，仅以原话字面为准',
    剧集: destiny.segments.map((s, i) => ({ 集: i + 1, 标题: s.title, 文本: s.text })),
    地点: destiny.location || '',
    画面描述: destiny.visualForImage || {}
  };
  if (journeyContext) payload.事件账本 = journeyContext.ledgerSummary;
  return JSON.stringify(payload, null, 1);
}

function buildSemanticQuestions({ withLedger }) {
  const questions = {};
  for (const q of POSITIVE_CHECKS) {
    questions[q.id] = { type: 'noul', instructions: q.instructions, criteria: q.criteria };
  }
  for (const q of NEGATIVE_CHECKS) {
    questions[q.id] = { type: 'noul', instructions: q.instructions, criteria: q.criteria };
  }
  if (withLedger) questions[LEDGER_CHECK.id] = { type: 'noul', instructions: LEDGER_CHECK.instructions, criteria: LEDGER_CHECK.criteria };
  return questions;
}

/** 确定性决策：把 noul 概率映射为 pass / weak / fail（不引入任何模型自由裁量） */
function decideCheck(check, noul, th) {
  const n = typeof noul === 'number' ? noul : null;
  if (n == null) return { id: check.id, dim: check.dim, kind: 'error', verdict: 'fail', noul: null, reason: '缺少判断值' };
  const isPositive = POSITIVE_CHECKS.some(c => c.id === check.id);
  if (isPositive) {
    if (n >= th.acceptMin) return { id: check.id, dim: check.dim, kind: 'positive', verdict: 'pass', noul: n };
    if (n <= th.failMin) return { id: check.id, dim: check.dim, kind: 'positive', verdict: 'fail', noul: n };
    return { id: check.id, dim: check.dim, kind: 'positive', verdict: 'weak', noul: n };
  }
  // 反向
  if (n <= th.failMax) return { id: check.id, dim: check.dim, kind: 'negative', verdict: 'pass', noul: n };
  if (n >= th.alarmMin) return { id: check.id, dim: check.dim, kind: 'negative', verdict: 'fail', noul: n };
  return { id: check.id, dim: check.dim, kind: 'negative', verdict: 'weak', noul: n };
}

/**
 * 语义验收。返回 { degraded, reason, checks, failures, judge }。
 * degraded=true 表示本轮未经语义判断（绝不把未评估记录成通过）。
 */
async function checkSemantics({ feeling, situationResult, destiny, journeyContext, deps } = {}) {
  const th = thresholds();
  const judge = deps?.jevJudge || jevJudge;
  const withLedger = !!journeyContext;
  try {
    const state = buildSemanticState({ feeling, situationResult, destiny, journeyContext });
    const questions = buildSemanticQuestions({ withLedger });
    const r = await judge(state, questions);
    const checks = [];
    for (const def of [...POSITIVE_CHECKS, ...NEGATIVE_CHECKS, ...(withLedger ? [LEDGER_CHECK] : [])]) {
      const a = r.answers[def.id];
      checks.push(decideCheck(def, a?.noul, th));
    }
    const failures = checks.filter(c => c.verdict === 'fail');
    return {
      degraded: false,
      checks,
      failures,
      weak: checks.filter(c => c.verdict === 'weak'),
      judge: { model: r.model, latencyMs: r.latencyMs, usage: r.usage, questionCount: Object.keys(questions).length }
    };
  } catch (err) {
    const code = err instanceof JeVError ? err.code : (err && err.code ? String(err.code) : 'UNKNOWN');
    return {
      degraded: true,
      degradeReason: `semantic_judge_${code}`,
      degradeDetail: err.message,
      checks: [],
      failures: [],
      weak: [],
      judge: null
    };
  }
}

module.exports = {
  checkStructure,
  checkSemantics,
  decideCheck,
  POSITIVE_CHECKS,
  NEGATIVE_CHECKS,
  LEDGER_CHECK,
  SEGMENT_MIN_CHARS,
  SEGMENT_MAX_CHARS
};
