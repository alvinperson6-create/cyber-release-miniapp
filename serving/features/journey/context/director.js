// 赛博放生 · LLM 世界导演契约层
//
// 边界（阶段 3.1）：本模块是纯的——构造提示词、解析 JSON、校验 schema
// 都不访问数据库、不访问网络、不读环境变量。
// 模型调用与记账在 adapters/text-model；业务事实在 commits 层提交。
//
// 职责：
// - 导演提案：处境 + 既有事实约束 + 2-4 个有真实代价的动态候选动作 + 机制摘要
// - 结算：已选行动的环境后果 + 最小事实增量 + 机制卡；不得改写已选行动
// - 信号/来信：只能叙述已提交事实与生物视角；信号不施压不剧透
// - 幽默默认"荒诞但温和"；语气偏好只影响未来生成
// - 全部输出走严格 JSON + 程序校验；解析/校验失败如实返回，不做模板伪装
// 契约版本：journey-director-v1

const { CREATURES, WATERS } = require('../../../../shared/contracts/vocabulary');

const DIRECTOR_VERSION = 'journey-director-v1';

const FACT_KINDS = ['location', 'goal', 'promise', 'resource', 'relationship', 'open_thread', 'action', 'consequence', 'trigger'];
const FACT_KIND_DESC = {
  location: '地点/去向', goal: '目标', promise: '承诺', resource: '重要资源与物件',
  relationship: '关系', open_thread: '未了之事', action: '已选行动',
  consequence: '后果', trigger: '下一次触发条件'
};

const TONE_DESC = {
  gentle: '克制温和：荒诞点到为止，允许平静、安静甚至不抖包袱的段落，重点在处境本身',
  balanced: '荒诞但温和：笑点落在荒诞规则、错误激励、意外代价和生物认真面对离谱局面',
  absurd: '更荒唐一点：允许设定更大胆、规则更离谱，但依然不贬低用户、不把用户的痛苦当包袱'
};

function toneText(tone) {
  return TONE_DESC[tone] || TONE_DESC.balanced;
}

// ---------- 严格 JSON 提取 ----------
function parseJsonLoose(text) {
  let raw = String(text || '').trim();
  raw = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '');
  try {
    return { ok: true, data: JSON.parse(raw) };
  } catch (e) {
    // 容忍前后缀：抓第一个 { 到最后一个 }
    const i = raw.indexOf('{');
    const j = raw.lastIndexOf('}');
    if (i >= 0 && j > i) {
      try {
        return { ok: true, data: JSON.parse(raw.slice(i, j + 1)) };
      } catch (e2) { /* fallthrough */ }
    }
    return { ok: false, error: `JSON 解析失败: ${e.message}` };
  }
}

const s = (v, max = 300) => String(v ?? '').trim().slice(0, max);

// ---------- 校验器（纯程序） ----------
function validateProposal(p) {
  if (!p || typeof p !== 'object') return { ok: false, error: '提案不是对象' };
  if (!s(p.title, 40)) return { ok: false, error: '缺 title' };
  if (!s(p.situation, 400) || s(p.situation).length < 10) return { ok: false, error: 'situation 缺失或过短' };
  // 宽进严出：先把模型输出归一化成 {id,label,cost}，再校验
  const rawActions = Array.isArray(p.actions) ? p.actions : [];
  if (rawActions.length < 2 || rawActions.length > 4) return { ok: false, error: `候选动作应为 2-4 个，实际 ${rawActions.length}` };
  const actions = [];
  for (let i = 0; i < rawActions.length; i++) {
    const a = rawActions[i];
    if (a == null) continue;
    if (typeof a === 'string') {
      actions.push({ id: `a${actions.length + 1}`, label: s(a, 30), cost: '' });
      continue;
    }
    const id = s(a.id, 20) || `a${actions.length + 1}`;
    const label = s(a.label ?? a.action ?? a.name ?? a.title, 30);
    const cost = s(a.cost ?? a.price ?? a.tradeoff, 120);
    if (!label) continue;
    actions.push({ id, label, cost });
  }
  if (actions.length < 2) return { ok: false, error: '可辨认的候选动作不足 2 个（每个需要 label 与真实代价）' };
  const ids = new Set();
  for (const a of actions) {
    if (ids.has(a.id)) return { ok: false, error: '动作 id 重复' };
    ids.add(a.id);
    if (!a.cost) return { ok: false, error: `动作「${a.label}」缺真实代价 cost` };
  }
  const m = p.mechanism_summary || {};
  if (!s(m.pressure, 200) || !s(m.dilemma, 200) || !s(m.cost, 200)) return { ok: false, error: 'mechanism_summary 需含 pressure/dilemma/cost' };
  const types = Array.isArray(p.expected_fact_types) ? p.expected_fact_types.filter(t => FACT_KINDS.includes(t)) : [];
  return {
    ok: true,
    proposal: {
      title: s(p.title, 40),
      situation: s(p.situation, 400),
      constraints: (Array.isArray(p.constraints) ? p.constraints : []).map(c => s(c, 160)).filter(Boolean).slice(0, 5),
      actions,
      mechanism_summary: { pressure: s(m.pressure, 200), dilemma: s(m.dilemma, 200), cost: s(m.cost, 200) },
      expected_fact_types: types
    }
  };
}

function validateSettlement(o) {
  if (!o || typeof o !== 'object') return { ok: false, error: '结算不是对象' };
  const narrative = s(o.narrative, 500);
  if (narrative.length < 10) return { ok: false, error: 'narrative 缺失或过短' };
  const facts = (Array.isArray(o.facts) ? o.facts : [])
    .map(f => ({ kind: FACT_KINDS.includes(f?.kind) ? f.kind : null, content: s(f?.content, 300) }))
    .filter(f => f.kind && f.content).slice(0, 6);
  const card = o.mechanism_card || {};
  if (!s(card.pressure, 300) || !s(card.dilemma, 300) || !s(card.choice_cost, 300) || !s(card.lasting_consequence, 300)) {
    return { ok: false, error: 'mechanism_card 需含 pressure/dilemma/choice_cost/lasting_consequence' };
  }
  return {
    ok: true,
    settlement: {
      narrative,
      facts,
      mechanism_card: {
        pressure: s(card.pressure, 300), dilemma: s(card.dilemma, 300),
        choice_cost: s(card.choice_cost, 300), lasting_consequence: s(card.lasting_consequence, 300)
      },
      next_trigger: s(o.next_trigger, 200)
    }
  };
}

function validateText(v, { min = 5, max = 700, field = 'text' } = {}) {
  const t = s(v, max);
  if (t.length < min) return { ok: false, error: `${field} 缺失或过短` };
  return { ok: true, text: t };
}

// ---------- 生物/旅程通用头部 ----------
function creatureHeader(journey) {
  const species = journey.species;
  const water = journey.water;
  return {
    creatureName: CREATURES[species]?.name || species,
    waterName: WATERS[water]?.name || water,
    waterType: WATERS[water]?.type || '水域'
  };
}

function worldRules(tone) {
  return [
    '【世界规则】',
    '- 你是文字世界的导演，负责提出具体遭遇；生物的行动由它自己决定，你不能替它选，也不能在后果里写成它做了别的事',
    '- 候选动作必须动态生成（不是固定模板），每个都要当下可行且有真实代价',
    '- 幽默边界：荒诞规则、错误激励、意外代价、生物认真面对离谱局面；不把用户的痛苦、能力、人格当包袱，不贬低用户',
    '- 允许平静、意外、尴尬、偶尔不抖包袱的段落',
    `- 荒诞程度与文风基调：${toneText(tone)}`,
    '- 不得编造用户未提供的个人事实（公司、人名、科目、书名等）；用户原话只作为动机背景'
  ].join('\n');
}

// ---------- 开局 ----------
function buildOpeningMessages({ journey, motivation, now }) {
  const { creatureName, waterName, waterType } = creatureHeader(journey);
  const system = [
    `你是"赛博放生"里一个文字世界的导演。一位用户把一只${creatureName}放生到${waterName}（${waterType}）。这只生物带着自己的轻量目标进入不断展开的文字世界。你要给它一个自身的目标（不宏大、不承诺解决用户的问题），并提出第一个具体遭遇。`,
    worldRules(journey.tone),
    '',
    '输出严格 JSON（不要 markdown 包裹、不要解释）：',
    '{',
    '  "goal": "生物自己的轻量目标，一句话，第一人称，与它的处境相关",',
    '  "encounter": {',
    '    "title": "遭遇标题（10字内）",',
    '    "situation": "当前具体处境（60-150字，以生物第一人称「我」叙述：具体场景与提出要求的一方）",',
    '    "constraints": ["由既有事实/身份引出的约束，0-3条"],',
    '    "actions": [{"id":"a1","label":"行动短标签（10字内）","cost":"真实代价（一句话）"}],',
    '    "mechanism_summary": {"pressure":"压力来源","dilemma":"真正的两难","cost":"可能的代价"},',
    '    "expected_fact_types": ["location","relationship"]',
    '  }',
    '}'
  ].join('\n');
  const user = [
    `生物：${creatureName}`,
    `水域：${waterName}（${waterType}）`,
    `用户放生时写下的原话（动机背景，不得改写原意，不得虚构其细节）：「${motivation.rawText}」`,
    motivation.items && motivation.items.length
      ? `程序识别到的具体处境（可参考，证据不足的不要硬用）：\n${motivation.items.map(i => `- ${i.label}${i.evidence ? `（证据：「${i.evidence}」）` : ''}`).join('\n')}`
      : '程序未能确认具体处境：紧扣原话字面，不要替用户虚构具体遭遇。',
    `当前时间：${new Date(now).toISOString()}`,
    '',
    '请给出开局 JSON。'
  ].join('\n');
  return { system, user };
}

// ---------- 后续遭遇提案 ----------
function buildProposalMessages({ journey, motivation, facts, recentCards, openThreads, lastSettlement, now }) {
  const { creatureName, waterName } = creatureHeader(journey);
  const system = [
    `你是${creatureName}所在文字世界的导演（水域：${waterName}）。上一件事刚刚落定，你要提出下一次具体遭遇。`,
    worldRules(journey.tone),
    '',
    '输出严格 JSON（结构同开局遭遇对象，不要 goal）：',
    '{ "title": "...", "situation": "...", "constraints": [...], "actions": [...], "mechanism_summary": {...}, "expected_fact_types": [...] }',
    'actions 给 2-4 个当下可行、可区分、各有真实代价的行动；数量由这次两难的可区分选项决定，不要固定给两个。',
    'situation 用生物第一人称「我」叙述。'
  ].join('\n');
  const user = [
    `生物自身目标：「${journey.goal || '（未设定）'}」`,
    motivation ? `本程动机档案（v${motivation.version}，供氛围与处境参考，不是每件事的隐喻素材）：「${motivation.rawText}」` : '',
    facts.length ? `已发生的事实（权威，必须承接，不得矛盾）：\n${facts.slice(-14).map(f => `- [${FACT_KIND_DESC[f.kind] || f.kind}] ${f.content}`).join('\n')}` : '尚无已提交事实。',
    openThreads.length ? `未了之事：\n${openThreads.map(f => `- ${f.content}`).join('\n')}` : '',
    recentCards.length ? `最近的机制卡（压力—两难—代价—后果；新遭遇不得换皮重复，道具/地点可以不同）：\n${recentCards.map((c, i) => `${i + 1}. 压力：${c.pressure}｜两难：${c.dilemma}｜代价：${c.choice_cost}｜持久后果：${c.lasting_consequence}`).join('\n')}` : '',
    lastSettlement?.next_trigger ? `上一次结算给出的触发线索：${lastSettlement.next_trigger}` : '',
    '',
    '请提出下一遭遇 JSON。'
  ].filter(Boolean).join('\n');
  return { system, user };
}

// ---------- 定向重提案（去重触发；最多一次） ----------
function buildReproposalMessages({ journey, facts, recentCards, rejectedProposal, now }) {
  const { creatureName } = creatureHeader(journey);
  const system = [
    `你是${creatureName}所在文字世界的导演。你上一次提出的遭遇被程序判定与已发生的机制高度重复，需要换一个真正不同的两难。`,
    worldRules(journey.tone),
    '',
    '输出严格 JSON（结构同遭遇对象）。',
    'actions 给 2-4 个当下可行、可区分、各有真实代价的行动；数量由新两难的可区分选项决定，不要固定给两个。',
    'situation 用生物第一人称「我」叙述。'
  ].join('\n');
  const user = [
    `被驳回的提案：${JSON.stringify(rejectedProposal)}`,
    `重复的机制卡（禁止再写压力/两难/代价/后果相同的变体）：\n${recentCards.map((c, i) => `${i + 1}. ${c.pressure}｜${c.dilemma}｜${c.choice_cost}｜${c.lasting_consequence}`).join('\n')}`,
    facts.length ? `已发生事实（必须承接）：\n${facts.slice(-10).map(f => `- ${f.content}`).join('\n')}` : '',
    '',
    '请给出机制不同的新遭遇 JSON。'
  ].filter(Boolean).join('\n');
  return { system, user };
}

// ---------- 结算 ----------
function buildSettlementMessages({ journey, encounter, facts, now }) {
  const { creatureName } = creatureHeader(journey);
  const chosen = encounter.proposal.actions.find(a => a.id === encounter.chosenAction);
  const system = [
    `你是${creatureName}所在文字世界的导演。生物已经做出选择，你来结算这次行动的环境后果。`,
    worldRules(journey.tone),
    '【铁则】',
    `- 生物的行动是「${chosen?.label || encounter.chosenAction}」，这不可改写：后果必须是这个行动的后果，不能写成它做了别的事`,
    '- 只结算环境后果与最小事实增量；不要替生物做下一个决定',
    '- narrative 里不宣布未发生的后果；新事实只写这次确实改变的',
    '',
    '输出严格 JSON：',
    '{',
    '  "narrative": "后果叙述（60-160字，以生物第一人称「我」讲述这次行动的后果，具体、有画面；允许荒诞或平静）",',
    '  "facts": [{"kind":"consequence","content":"一条具体的事实增量"}],',
    '  "mechanism_card": {"pressure":"压力来源","dilemma":"真正的两难","choice_cost":"这次选择的实际代价","lasting_consequence":"持久后果"},',
    '  "next_trigger": "什么可能引出下一件事（一句话，可选）"',
    '}'
  ].join('\n');
  const user = [
    `遭遇：${encounter.proposal.title} —— ${encounter.proposal.situation}`,
    `候选动作与代价：${encounter.proposal.actions.map(a => `${a.label}（${a.cost}）`).join('；')}`,
    `生物实际选择：「${chosen?.label || encounter.chosenAction}」`,
    encounter.supplyMessageId ? '生物行动前收到了用户的一句话补给（可体现在它的底气/犹豫里，但补给不是命令）。' : '',
    facts.length ? `此前事实：\n${facts.slice(-12).map(f => `- [${FACT_KIND_DESC[f.kind] || f.kind}] ${f.content}`).join('\n')}` : '',
    '',
    '请结算 JSON。'
  ].filter(Boolean).join('\n');
  return { system, user };
}

// ---------- 可回应信号 ----------
function buildSignalMessages({ journey, encounter, facts, now }) {
  const { creatureName } = creatureHeader(journey);
  const system = [
    `你是${creatureName}。你正面对一件还没决定怎么做的具体遭遇，决定在行动前先给主人寄一个很短的信号。`,
    '【信号规则】',
    '- 只讲这一件未决处境：遇到了什么、你在犹豫什么、主人可以用一句话补什么（信息/态度/许可，任选其一提）',
    '- 简短（50-110 字），只轻微荒诞，不剧透任何后果',
    '- 严禁施压：不得暗示"不回复你就会受害/完蛋"，不得给回复设人道代价',
    '- 语气像给老朋友发消息，输出严格 JSON：{"text":"信号正文"}'
  ].join('\n');
  const user = [
    `你的目标：「${journey.goal || ''}」`,
    `遭遇：${encounter.proposal.title} —— ${encounter.proposal.situation}`,
    `你在犹豫的选项：${encounter.proposal.actions.map(a => `${a.label}（${a.cost}）`).join('；')}`,
    facts.length ? `相关往事：\n${facts.slice(-6).map(f => `- ${f.content}`).join('\n')}` : '',
    '',
    '请写信号 JSON。'
  ].filter(Boolean).join('\n');
  return { system, user };
}

// ---------- 经历来信（阶段/收束） ----------
function buildLetterMessages({ journey, motivation, facts, recentEncounters, kind, supplies, now }) {
  const { creatureName, waterName } = creatureHeader(journey);
  const isFinal = kind === 'final_letter';
  const system = [
    `你是${creatureName}，此刻在${waterName}一带，给放生你的主人写一封信。`,
    isFinal
      ? '这是本程的最后一封经历来信：旅程自然收束，可以回味、道别，也可以留一点没说完的话；不必总结全部，只讲你最有感触的一段。'
      : '这是一封阶段经历来信：只讲本程这一段，可以留悬念和未了之事，不必概括旅程。',
    '【来信规则】',
    '- 只能叙述已经发生的事实和你的视角，不得虚构没发生的事，不得宣称用户没提供过的个人细节',
    '- 可以有情绪、幽默、荒诞；不贬低用户，不把用户的痛苦当笑点，不说教',
    `- 荒诞程度：${toneText(journey.tone)}`,
    '- 100-240 字，像认真的信，不像系统通知。输出严格 JSON：{"title":"信的标题（12字内）","text":"信的正文"}'
  ].join('\n');
  const user = [
    `你的目标：「${journey.goal || ''}」`,
    motivation ? `主人放生你时写过：「${motivation.rawText}」（可以呼应，不必复述）` : '',
    supplies.length ? `主人后来捎的话：\n${supplies.map(m => `- 「${m.text}」`).join('\n')}` : '',
    facts.length ? `这段旅程里确实发生的：\n${facts.slice(-16).map(f => `- ${f.content}`).join('\n')}` : '（还没有落定的事件：写进入水域后的最初感受即可，不得虚构事件）',
    recentEncounters.length ? `经历过的遭遇：${recentEncounters.map(e => e.proposal.title).join('、')}` : '',
    '',
    isFinal ? '请写收束来信 JSON。' : '请写阶段来信 JSON。'
  ].filter(Boolean).join('\n');
  return { system, user };
}

module.exports = {
  DIRECTOR_VERSION,
  FACT_KINDS, FACT_KIND_DESC, TONE_DESC,
  parseJsonLoose, validateProposal, validateSettlement, validateText,
  buildOpeningMessages, buildProposalMessages, buildReproposalMessages,
  buildSettlementMessages, buildSignalMessages, buildLetterMessages,
  creatureHeader, toneText, worldRules
};
