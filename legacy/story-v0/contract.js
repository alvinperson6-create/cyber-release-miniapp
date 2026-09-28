// 赛博放生 · 创作契约（确定性组装）
//
// 把「原文 + 被支持的处境 + 生物/水域/时间 + 人设 + 行为要求 + 事实边界」
// 确定性地编译成一段注入生成提示词的契约文本。契约是纯函数产物——
// 相同输入必产出相同文本，便于离线测试与版本追踪（handoff §4.1）。
// 生成模型拿到的是完整原文与句段证据，不是几个光秃秃的标签。

const { CONTRACT_VERSION } = require('./situations');

// 处境 → 必须表现的行为倾向（确定性映射，不靠模型自由发挥）
const TENDENCY_BY_SITUATION = {
  task_overload:        '被任务推着走、想休息却停不下来，会做出“自动化偷懒反而更忙”之类的具体行为',
  lost_control:         '想抓住控制权：反复确认、囤积、自定规矩，但局面总在它控制之外',
  time_boundary:        '对“最后关头被打断”极度敏感，总在快完成一件事时被叫走',
  effort_uncredited:    '渴望被看见：会主动收集“功劳凭证”或准备领奖，但总差一步',
  outcome_uncertain:    '反复检查、求签占卜、准备 Plan B 到 Plan Z，被不确定感推着走',
  relationship_loss:    '珍惜同伴、害怕散场：会做出挽留、纪念、打包回忆的具体行为',
  cannot_refuse:        '来者不拒：答应所有请求，把自己的事永远排在最后',
  positive_anticipation:'满怀期待、提前庆祝：为还没发生的好事大张旗鼓'
};

// 所有生成必须遵守的通用红线（与旧 prompt 的禁止事项一致，此处收敛为契约条款）
const UNIVERSAL_AVOID = [
  '不得虚构用户未提供的事实（公司名、人名、科目、书名、考试内容等具体信息）',
  '不写温暖治愈的说教与安慰（“别紧张/会好的/加油”）',
  '不靠贬低用户本人制造笑点；调侃对象落在处境、生物自身和荒诞规则上'
];

/**
 * 组装创作契约。
 * @param {object} p
 * @param {object} p.situationResult recognizeSituations 的结果（可能 degraded）
 * @param {string} p.feeling 原始输入
 * @param {string} p.creatureName 生物中文名
 * @param {string} p.waterName 水域中文名
 * @param {string} p.replyTimeLabel 回信时间描述
 * @param {object|null} p.journeyContext 事件实验上下文（第二阶段）：{ ledgerSummary, tendencyNote }
 */
function buildCreationContract({ feeling, situationResult, creatureName, waterName, replyTimeLabel, journeyContext }) {
  const sentences = situationResult?.sentences || [];
  const items = situationResult?.items || [];
  const supported = items.filter(i => i.usable && i.evidenceText);
  const contradicted = items.filter(i => i.stance === 'contradicted');
  const ambiguous = items.filter(i => i.stance === 'ambiguous');
  const degraded = !situationResult || situationResult.degraded;

  const tendencies = supported
    .map(i => TENDENCY_BY_SITUATION[i.id])
    .filter(Boolean);

  const contract = {
    contractVersion: CONTRACT_VERSION,
    judgeStatus: degraded ? 'degraded' : 'ok',
    degradeReason: degraded ? (situationResult?.degradeReason || 'situation_unavailable') : null,
    feeling: String(feeling || ''),
    sentences: sentences.map(s => ({ id: s.id, text: s.text })),
    supported: supported.map(i => ({ id: i.id, label: i.label, evidence: i.evidenceText })),
    contradicted: contradicted.map(i => ({ id: i.id, label: i.label })),
    ambiguous: ambiguous.map(i => ({ id: i.id, label: i.label })),
    requiredTendencies: [...new Set(tendencies)],
    journeyContext: journeyContext || null
  };

  contract.promptText = compilePromptText(contract, { creatureName, waterName, replyTimeLabel });
  return contract;
}

function compilePromptText(c, { creatureName, waterName, replyTimeLabel }) {
  const lines = [];
  lines.push('【创作契约】（以下为经程序编译的创作约束，与剧情规则冲突时以本契约为准）');
  lines.push(`- 契约版本：${c.contractVersion}`);
  lines.push(`- 处境判断来源：${c.judgeStatus === 'ok' ? 'JEV 语义判断（已核验）' : `判断不可用，降级生成（${c.degradeReason}）。此时只依据原文字面，不要臆测具体处境`}`);

  lines.push(`- 用户原话（权威事实，不得改写、不得缩写）：「${c.feeling}」`);
  if (c.sentences.length > 1) {
    lines.push('- 原话句段表：');
    for (const s of c.sentences) lines.push(`    ${s.id}: ${s.text}`);
  }

  if (c.supported.length) {
    lines.push('- 被原话支持的具体处境（剧情必须围绕它们展开，生物的具体行为要能对应到证据句）：');
    for (const s of c.supported) {
      lines.push(`    · ${s.label} —— 证据句：「${s.evidence}」`);
    }
    lines.push('- 必须表现的行为倾向：');
    for (const t of c.requiredTendencies) lines.push(`    · ${t}`);
  } else {
    lines.push('- 没有可确认的具体处境：紧扣原话字面情绪写剧情，不得替用户虚构具体遭遇');
  }

  if (c.contradicted.length) {
    lines.push(`- 被原话反驳的处境（禁止写成主线）：${c.contradicted.map(i => i.label).join('、')}`);
  }
  if (c.ambiguous.length) {
    lines.push(`- 含糊未表达的处境（不要强行编造成事实）：${c.ambiguous.map(i => i.label).join('、')}`);
  }

  lines.push('- 事实边界：用户只提供了上面这句原话。虚构 NPC、生物遭遇、荒诞设定都可以；但对用户本人的一切具体事实断言（公司/人名/科目/书名等）只能来自原话原文');
  lines.push(`- 场景锚点：生物 ${creatureName}，水域 ${waterName}，回信时间「${replyTimeLabel}」`);
  lines.push('- 需要避开的表达：' + UNIVERSAL_AVOID.join('；'));
  lines.push('- 结构要求：四集因果链——上一集生物的具体行为要直接推动下一集的事件；第 4 集结局由上述处境一步步导致，且地点/画面与前文一致');

  if (c.journeyContext) {
    lines.push('- 【事件账本】（本轮旅程已真实发生的事件，回信与结局必须与账本一致，不得另造矛盾的关键行为）：');
    lines.push(c.journeyContext.ledgerSummary);
    if (c.journeyContext.tendencyNote) lines.push(`    · 行为倾向说明：${c.journeyContext.tendencyNote}`);
  }
  return lines.join('\n');
}

module.exports = { buildCreationContract, TENDENCY_BY_SITUATION, UNIVERSAL_AVOID };
