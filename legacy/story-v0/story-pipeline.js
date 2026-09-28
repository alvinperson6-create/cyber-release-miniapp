// 赛博放生 · 统一故事编排核心（第一阶段）
//
// 流程（handoff §4.3）：
//   原始输入 → 处境判断(可降级) → 程序组装创作契约 → 文本模型生成剧本
//   → 程序检查结构 → JEV 检查语义缺口 → 程序决策：接受/修复一次/明确降级
//   → 冻结已接受版本（由调用方持久化；回信/画面描述都从这个版本派生）
//
// 纪律：
// - 生成预算 = 1 次初始生成 + STORY_REPAIR_MAX 次定向修复（默认 1），结构/语义修复共享预算，
//   绝无“直到模型满意”；语义判断(JEV)不占生成预算（成本低，允许修复后复查）
// - 修复 prompt 只携带失败维度与相关材料
// - 任何失败/未评估都如实记录到 meta.status，绝不伪装成通过
// - 两条生产入口（调度器 reply-generator 与 HTTP /api/reply/generate）都必须经此核心

const ai = require('./ai');
const { recognizeSituations } = require('./situations');
const { buildCreationContract } = require('./contract');
const { checkStructure, checkSemantics } = require('./acceptance');
const { jevPipelineEnabled, repairMax } = require('./flags');
const { jevJudge } = require('./jev');
const { CREATURES, WATERS } = require('./data');

const PIPELINE_VERSION = 'story-pipeline-v1';

function emptyUsage() {
  return { calls: 0, inputTokens: 0, outputTokens: 0, latencyMs: 0 };
}
function addUsage(acc, usage, latencyMs) {
  acc.calls += 1;
  acc.inputTokens += usage?.input_tokens || 0;
  acc.outputTokens += usage?.output_tokens || 0;
  acc.latencyMs += latencyMs || 0;
}

/** 把验收失败转成给修复模型的定向修订清单（含受影响的剧集范围） */
function buildFailureReport(structural, semantic) {
  const lines = [];
  const scopeOf = (id) => {
    const map = {
      behavior_change: '全部剧集（重点是处境→行为的具体化）',
      causal_1_2: '第1-2集',
      causal_2_3: '第2-3集',
      causal_3_4: '第3-4集',
      ending_foreshadowed: '第4集及前文伏笔',
      fabricated_user_facts: '出现虚构事实的位置（全篇排查）',
      mockery_beyond_boundary: '第4集笑点落点',
      reply_visual_conflict: 'location / visualForImage / 第4集文本',
      ledger_consistency: '第4集及结局（对照事件账本）'
    };
    return map[id] || '相关剧集';
  };
  for (const issue of structural || []) {
    lines.push(`- [结构] ${issue.reason}`);
  }
  for (const f of semantic || []) {
    lines.push(`- [语义] ${f.dim} 未通过（判断概率 ${typeof f.noul === 'number' ? f.noul.toFixed(2) : '?'}）。修复范围：${scopeOf(f.id)}`);
  }
  return lines.join('\n');
}

async function generateOnce({ feeling, creature, water, replyTimeLabel, contractText, kind }) {
  const messages = ai.buildDestinyPrompt({ feeling, creature, water, replyTimeLabel, contractText });
  const r = await ai.chatCompletion(messages, { temperature: 0.85, max_tokens: 16000, thinking: true });
  ai.recordUsage(kind, r);
  const parsed = ai.parseDestinySegmentsStrict(r.content);
  return { parsed, callMeta: { usage: r.usage, latencyMs: r.latencyMs, model: r.model, finishReason: r.finishReason } };
}

async function repairOnce({ feeling, creature, water, replyTimeLabel, contractText, previousDestiny, failureReport }) {
  const messages = ai.buildDestinyRepairPrompt({
    feeling,
    creatureName: CREATURES[creature]?.name || creature,
    waterName: WATERS[water]?.name || water,
    replyTimeLabel,
    contractText,
    previousJson: JSON.stringify({
      location: previousDestiny.location,
      visualForImage: previousDestiny.visualForImage,
      segments: previousDestiny.segments.map(s => ({ title: s.title, text: s.text, emoji: s.emoji }))
    }, null, 1),
    failureReport
  });
  const r = await ai.chatCompletion(messages, { temperature: 0.6, max_tokens: 16000, thinking: true });
  ai.recordUsage('destiny_repair', r);
  const parsed = ai.parseDestinySegmentsStrict(r.content);
  return { parsed, callMeta: { usage: r.usage, latencyMs: r.latencyMs, model: r.model, finishReason: r.finishReason } };
}

/**
 * 统一编排核心。
 * @param {object} p { feeling, creature, water, replyTimeLabel, journeyContext? }
 * @returns {{ destiny:object, meta:object }} meta.status ∈
 *   accepted | repaired | degraded | judge_unavailable | legacy | template_fallback
 */
async function createStoryForRecord(p) {
  const { feeling, creature, water, replyTimeLabel } = p;
  const t0 = Date.now();
  const meta = {
    pipelineVersion: PIPELINE_VERSION,
    status: 'legacy',
    situation: null,
    contract: null,
    structural: null,
    semantics: null,
    repairs: [],
    generation: emptyUsage(),
    judging: emptyUsage(),
    notes: [],
    textModel: ai.getConfig().model,
    journeyApplied: !!p.journeyContext,
    totalLatencyMs: 0
  };

  // 0. 无文本模型 → 本地模板（最底层兜底）
  if (!ai.isAIEnabled()) {
    meta.status = 'template_fallback';
    meta.notes.push('AI_API_KEY 未配置，使用本地模板');
    return { destiny: ai.templateDestiny({ creature, water, feeling }), meta };
  }

  // 1. JEV 链路关闭（开关关 / 无凭证）→ 明确走旧路径并记录 legacy
  if (!jevPipelineEnabled()) {
    meta.status = 'legacy';
    meta.notes.push(`JEV 链路关闭（JEV_ENABLED=${process.env.JEV_ENABLED ?? 'unset'}, JEV_API_KEY=${process.env.JEV_API_KEY ? 'set' : 'missing'}）`);
    try {
      const { parsed, callMeta } = await generateOnce({ feeling, creature, water, replyTimeLabel, kind: 'destiny' });
      addUsage(meta.generation, callMeta.usage, callMeta.latencyMs);
      if (parsed.ok) {
        meta.totalLatencyMs = Date.now() - t0;
        return { destiny: parsed.destiny, meta };
      }
      meta.notes.push(`旧路径解析失败（${parsed.error}），模板兜底`);
    } catch (err) {
      meta.notes.push(`旧路径生成失败（${err.message}），模板兜底`);
    }
    meta.status = 'template_fallback';
    meta.totalLatencyMs = Date.now() - t0;
    return { destiny: ai.templateDestiny({ creature, water, feeling }), meta };
  }

  meta.status = 'accepted';

  // 2. 处境判断（内部自带降级，不抛异常）
  const judgeDeps = p.deps?.jevJudge ? { jevJudge: p.deps.jevJudge } : { jevJudge };
  const situationResult = await recognizeSituations(feeling, { deps: judgeDeps });
  meta.situation = {
    degraded: situationResult.degraded,
    degradeReason: situationResult.degradeReason || null,
    supported: situationResult.supported?.map(i => ({ id: i.id, label: i.label, evidence: i.evidenceText })) || [],
    items: situationResult.items?.map(i => ({ id: i.id, stance: i.stance, confidence: i.confidence, usable: i.usable })) || []
  };
  if (situationResult.judge) addUsage(meta.judging, situationResult.judge.usage, situationResult.judge.latencyMs);
  if (situationResult.degraded) meta.notes.push(`处境判断降级：${situationResult.degradeReason}`);

  // 3. 组装创作契约（确定性）
  const contract = buildCreationContract({
    feeling,
    situationResult,
    creatureName: CREATURES[creature]?.name || creature,
    waterName: WATERS[water]?.name || water,
    replyTimeLabel,
    journeyContext: p.journeyContext || null
  });
  meta.contract = {
    contractVersion: contract.contractVersion,
    judgeStatus: contract.judgeStatus,
    supportedCount: contract.supported.length,
    requiredTendencies: contract.requiredTendencies
  };

  // 4. 初始生成 + 结构检查
  let current = null;
  let structural = checkStructure(null);
  try {
    const { parsed, callMeta } = await generateOnce({ feeling, creature, water, replyTimeLabel, contractText: contract.promptText, kind: 'destiny_contract' });
    addUsage(meta.generation, callMeta.usage, callMeta.latencyMs);
    if (parsed.ok) {
      current = parsed.destiny;
      structural = checkStructure(current);
      if (!structural.pass) meta.notes.push(`初始生成结构问题：${structural.issues.map(i => i.reason).join('；')}`);
    } else {
      meta.notes.push(`初始生成解析失败：${parsed.error}`);
    }
  } catch (err) {
    meta.notes.push(`初始生成失败：${err.message}`);
  }

  let budget = repairMax();

  // 5a. 结构修复（解析失败 / 四集/字段不完整）
  while (budget > 0 && (!current || !structural.pass)) {
    budget -= 1;
    const kind = 'structure';
    const failureReport = buildFailureReport(current ? (structural.pass ? [] : structural.issues) : [{ dim: 'structure', reason: '剧本 JSON 无法解析或缺少 segments' }], []);
    try {
      const base = current || ai.templateDestiny({ creature, water, feeling });
      const { parsed, callMeta } = await repairOnce({ feeling, creature, water, replyTimeLabel, contractText: contract.promptText, previousDestiny: base, failureReport });
      addUsage(meta.generation, callMeta.usage, callMeta.latencyMs);
      if (parsed.ok) {
        const rs = checkStructure(parsed.destiny);
        if (rs.pass) {
          current = parsed.destiny;
          structural = rs;
          meta.repairs.push({ kind, result: 'applied' });
        } else {
          meta.repairs.push({ kind, result: 'structure_still_failing', issues: rs.issues.map(i => i.reason) });
          break; // 预算已花，保留上一版进入后续判定
        }
      } else {
        meta.repairs.push({ kind, result: 'parse_failed', error: parsed.error });
        break;
      }
    } catch (err) {
      meta.repairs.push({ kind, result: 'error', error: err.message });
      break;
    }
  }

  // 结构最终仍失败 → 模板兜底（明确降级）
  if (!current || !structural.pass) {
    meta.status = 'degraded';
    meta.notes.push('结构修复预算耗尽或失败，回退本地模板');
    meta.totalLatencyMs = Date.now() - t0;
    return { destiny: ai.templateDestiny({ creature, water, feeling }), meta };
  }

  // 5b. 语义验收 + 定向修复
  const runSemantics = async () => {
    const s = await checkSemantics({ feeling, situationResult, destiny: current, journeyContext: p.journeyContext, deps: judgeDeps });
    meta.semantics = {
      degraded: s.degraded,
      degradeReason: s.degradeReason || null,
      checks: s.checks.map(c => ({ id: c.id, dim: c.dim, verdict: c.verdict, noul: c.noul })),
      failures: s.failures.map(f => ({ id: f.id, dim: f.dim, noul: f.noul })),
      weak: s.weak.map(w => ({ id: w.id, dim: w.dim, noul: w.noul }))
    };
    if (s.judge) addUsage(meta.judging, s.judge.usage, s.judge.latencyMs);
    return s;
  };

  let semantics = await runSemantics();
  if (semantics.degraded) {
    // 无判断即无修复依据：保持当前版本，如实记录（绝不把未评估记成通过）
    meta.status = 'judge_unavailable';
    meta.notes.push(`语义验收不可用：${semantics.degradeReason}（${semantics.degradeDetail || ''}）`);
    meta.totalLatencyMs = Date.now() - t0;
    return { destiny: current, meta };
  }

  while (budget > 0 && semantics.failures.length) {
    budget -= 1;
    const failureReport = buildFailureReport([], semantics.failures);
    console.log(`[pipeline] 定向修复（语义）：${semantics.failures.map(f => f.dim).join('、')}`);
    try {
      const { parsed, callMeta } = await repairOnce({ feeling, creature, water, replyTimeLabel, contractText: contract.promptText, previousDestiny: current, failureReport });
      addUsage(meta.generation, callMeta.usage, callMeta.latencyMs);
      if (parsed.ok) {
        const rs = checkStructure(parsed.destiny);
        if (rs.pass) {
          current = parsed.destiny;
          structural = rs;
          semantics = await runSemantics(); // 修复后复查（全量维度，成本低更保守）
          meta.repairs.push({ kind: 'semantic', result: semantics.failures.length ? 'applied_still_failing' : 'applied' });
        } else {
          meta.repairs.push({ kind: 'semantic', result: 'repair_structure_failed', issues: rs.issues.map(i => i.reason) });
          break;
        }
      } else {
        meta.repairs.push({ kind: 'semantic', result: 'parse_failed', error: parsed.error });
        break;
      }
    } catch (err) {
      meta.repairs.push({ kind: 'semantic', result: 'error', error: err.message });
      break;
    }
  }

  // 6. 终态判定（确定性）
  if (semantics.failures.length) {
    meta.status = 'degraded';
    meta.notes.push(`修复后仍有失败维度：${semantics.failures.map(f => f.dim).join('、')}（保留改善版本并如实标记）`);
  } else if (meta.repairs.length) {
    meta.status = 'repaired';
  } else {
    meta.status = 'accepted';
  }

  meta.totalLatencyMs = Date.now() - t0;
  return { destiny: current, meta };
}

module.exports = { createStoryForRecord, PIPELINE_VERSION, buildFailureReport };
