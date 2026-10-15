// 赛博放生 · 具体烦恼识别（处境判断）
//
// 边界（阶段 3.1）：本模块是纯的——分句、构造问题、解析答案都在这里；
// 网络调用通过注入的 jevAdapter 完成，模块本身不 require 网络适配器。
//
// 设计要点：
// - 处境集合是小而明确的起点，不是永久分类体系；允许多个同时成立
// - 每项 stance 为四值：supported / contradicted / unexpressed / ambiguous
// - 证据不要求 JEV 自由生成：程序预先分句并编号，JEV 只在合法句段 ID 中选择
// - 同一请求内问题彼此独立：stance 与 evidence 互不依赖
// - JEV 不可用/超时/解析失败 → 降级（degraded），绝不把未知强行变成否

const CONTRACT_VERSION = 'situation-contract-v1';

const SITUATIONS = [
  { id: 'task_overload', label: '任务过量', desc: '事情太多做不完、忙不过来、希望休息' },
  { id: 'lost_control', label: '失去选择权', desc: '被安排、被迫接受、自己说了不算' },
  { id: 'time_boundary', label: '时间边界被侵占', desc: '个人时间被打断、下班/休息时间被占用' },
  { id: 'effort_uncredited', label: '努力未获承认', desc: '做了很多但功劳归别人、付出没有被看见' },
  { id: 'outcome_uncertain', label: '对结果不确定', desc: '担心结果、不知道行不行、等待某个重要结果' },
  { id: 'relationship_loss', label: '关系失落', desc: '分手、吵架、疏远、失去陪伴' },
  { id: 'cannot_refuse', label: '难以拒绝请求', desc: '别人的请求都答应、不好意思说不、总帮别人' },
  { id: 'positive_anticipation', label: '积极期待或喜悦', desc: '真心的开心、期待好事发生（注意识别反话，讽刺句里的正面词不算）' }
];

const STANCES = ['supported', 'contradicted', 'unexpressed', 'ambiguous'];

/** 程序分句：按中文句末标点/换行切分；空段丢弃；最多 8 段 */
function splitSentences(feeling) {
  const text = String(feeling || '').trim();
  if (!text) return [];
  const parts = text
    .split(/(?<=[。！？!?；;\n])/)
    .map(s => s.trim())
    .filter(Boolean);
  const capped = parts.slice(0, 7);
  const rest = parts.slice(7).join('');
  if (rest) capped.push(rest);
  return capped.map((s, i) => ({ id: `s${i + 1}`, text: s }));
}

function buildSituationQuestions(sentences) {
  const sentenceTable = sentences.map(s => `${s.id}: ${s.text}`).join('\n');
  const questions = {};
  for (const st of SITUATIONS) {
    questions[`${st.id}__stance`] = {
      type: 'choice',
      instructions: `原文是否表达了「${st.label}」（${st.desc}）这一具体处境？注意：反话、讽刺里的正面词不算积极；混合情绪按字面证据判断。`,
      criteria: {
        supported: '原文有文字直接支持这个处境',
        contradicted: '原文文字明确与这个处境相反',
        unexpressed: '原文完全没有涉及这个处境',
        ambiguous: '原文提到相关字眼但无法确定是否表达这个处境'
      }
    };
    questions[`${st.id}__evidence`] = {
      type: 'choice',
      instructions: `若「${st.label}」被原文支持，支持它的句段是哪个？（独立判断，与上一题无关）`,
      criteria: Object.fromEntries(
        sentences.map(s => [s.id, `句段 ${s.id}: ${s.text}`]).concat([['none', '没有明确支持句段']])
      )
    };
  }
  return { questions, sentenceTable };
}

/**
 * 识别一句烦恼里被支持的具体处境。
 * @param jevAdapter 注入的 JEV 适配器实例（需 .judge()）
 * @returns 结果对象，含 degraded 标记；识别失败不抛异常
 */
async function recognizeSituations(feeling, { thresholds, jevAdapter, journeyId, taskId, operationId, now, budget } = {}) {
  const sentences = splitSentences(feeling);
  const base = {
    contractVersion: CONTRACT_VERSION,
    sentences,
    items: [],
    supported: [],
    degraded: false,
    degradeReason: null,
    judge: null
  };
  if (!sentences.length) {
    return { ...base, degraded: true, degradeReason: 'empty_input' };
  }
  if (!jevAdapter) {
    return { ...base, degraded: true, degradeReason: 'judge_unavailable' };
  }

  try {
    const { questions, sentenceTable } = buildSituationQuestions(sentences);
    const state = `用户对虚拟生物说出的原话：\n${String(feeling).trim()}\n\n句段表：\n${sentenceTable}`;
    const r = await jevAdapter.judge({
      op: 'situation_recognition',
      state, questions,
      journeyId, taskId, operationId, now, budget
    });
    if (!r.available) {
      return { ...base, degraded: true, degradeReason: `situation_judge_${r.reason || 'UNAVAILABLE'}` };
    }
    const minConf = thresholds?.situationMinConfidence ?? 0.45;

    const items = SITUATIONS.map(st => {
      const stanceAnswer = r.answers[`${st.id}__stance`];
      const evidenceAnswer = r.answers[`${st.id}__evidence`];
      const stance = stanceAnswer.choice;
      const evidenceId = evidenceAnswer.choice !== 'none' ? evidenceAnswer.choice : null;
      const evidenceSentence = evidenceId ? sentences.find(s => s.id === evidenceId) : null;
      const supported = stance === 'supported' && (stanceAnswer.confidence ?? 0) >= minConf && evidenceSentence;
      return {
        id: st.id,
        label: st.label,
        stance,
        confidence: stanceAnswer.confidence ?? null,
        evidenceSentenceId: supported ? evidenceId : null,
        evidenceText: supported ? evidenceSentence.text : null,
        usable: supported
      };
    });

    return {
      ...base,
      items,
      supported: items.filter(i => i.usable),
      degraded: false,
      judge: {
        model: r.model,
        latencyMs: r.latencyMs,
        usage: r.usage,
        questionCount: Object.keys(questions).length,
        minConfidence: minConf
      }
    };
  } catch (err) {
    const code = err?.code ? String(err.code) : 'UNKNOWN';
    return { ...base, degraded: true, degradeReason: `situation_judge_${code}`, degradeDetail: err.message };
  }
}

module.exports = { SITUATIONS, STANCES, CONTRACT_VERSION, splitSentences, buildSituationQuestions, recognizeSituations };
