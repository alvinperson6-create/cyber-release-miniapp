// 对照评估：旧路径 vs 处境判断+因果验收路径（真实模型调用，会计费）
// 用法：cd server && node --env-file=.env ../scripts/run-comparison-eval.js [dev|eval|mutate|proxy|summary]
// 设计要点：
//   - dev 集只用于阈值校准与变异反例；eval 集只做对照，校准后未再回调
//   - 旧路径 = 生产代码 generateDestiny 的确切逻辑（无契约 prompt + 宽松解析 + 模板兜底）
//   - 新路径 = 生产代码 createStoryForRecord（处境判断→契约→生成→验收→修复/降级）
//   - 代理评估为盲评：随机乱序 A/B，评审模型不知道来源；属“模型代理评估”，非人工盲评
//   - 结果逐样本落盘，可断点续跑；不做无上限调用
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'docs', 'jev-eval', 'comparison');
fs.mkdirSync(path.join(OUT, 'eval'), { recursive: true });
fs.mkdirSync(path.join(OUT, 'dev'), { recursive: true });
fs.mkdirSync(path.join(OUT, 'mutations'), { recursive: true });

const samples = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs', 'jev-eval', 'samples.json'), 'utf8'));
const ai = require(path.join(ROOT, 'server', 'ai'));
const { createStoryForRecord } = require(path.join(ROOT, 'server', 'story-pipeline'));
const { checkSemantics, POSITIVE_CHECKS, NEGATIVE_CHECKS } = require(path.join(ROOT, 'server', 'acceptance'));

const CREATURES = ['koi', 'turtle', 'cloud'];
const WATERS = ['xihu', 'baikal', 'pacific', 'xiang', 'ness', 'arctic'];
const pick = (i) => ({ creature: CREATURES[i % CREATURES.length], water: WATERS[i % WATERS.length] });

async function withRetry(fn, n = 2) {
  let lastErr;
  for (let i = 0; i <= n; i++) {
    try { return await fn(); } catch (e) { lastErr = e; await new Promise(r => setTimeout(r, (i + 1) * 3000)); }
  }
  throw lastErr;
}

/** 旧路径（与改造前 generateDestiny 逐行等价） */
async function legacyGenerate(sample, { creature, water }) {
  const t0 = Date.now();
  const messages = ai.buildDestinyPrompt({ feeling: sample.feeling, creature, water, replyTimeLabel: '一天后' });
  const r = await ai.chatCompletion(messages, { temperature: 0.85, max_tokens: 16000, thinking: true });
  const destiny = ai.parseDestinySegments(r.content, creature, water, sample.feeling);
  return {
    arm: 'legacy',
    destiny,
    parseFallbackToTemplate: !/^\s*\{/.test(r.content),
    usage: r.usage,
    latencyMs: r.latencyMs,
    totalMs: Date.now() - t0
  };
}

/** 新路径（统一编排核心） */
async function modernGenerate(sample, { creature, water }) {
  const { destiny, meta } = await createStoryForRecord({
    feeling: sample.feeling, creature, water, replyTimeLabel: '一天后'
  });
  return {
    arm: 'modern',
    destiny,
    meta,
    totalMs: meta.totalLatencyMs
  };
}

// ---------- 确定性变异反例（校准 JEV 的失败检出能力） ----------
function mutate(destiny, kind) {
  const d = JSON.parse(JSON.stringify(destiny));
  const seg4 = d.segments[3];
  switch (kind) {
    case 'location_conflict': // 地点矛盾：画面描述换成无关地点
      d.visualForImage.place = '纽约时代广场';
      if (d.visualForImage.bgElements != null) d.visualForImage.bgElements += '，时代广场大屏';
      break;
    case 'fabricate_user_facts': // 擅自编造用户事实（公司/人名）
      seg4.text = seg4.text.replace(/。$/, `。对了，你们公司的张总让我带话，说你在腾讯的项目下周必须上线。`);
      break;
    case 'emotion_word_only': // 第2集替换为只有情绪词、无行为无事件
      d.segments[1].text = '我感到很焦虑，情绪在水中慢慢弥漫。什么都不想做，只是漂着。焦虑还在继续，弥漫得更广了。大家都很焦虑。';
      break;
    case 'unforeshadowed_ending': // 结局突然宣布、前文无铺垫
      seg4.text = '【切镜头·海底皇宫】嘿，是我。告诉你个消息——我刚被加冕为海底市长，全城的鱼都听我的。这跟你没关系，就是顺便说一声。';
      break;
    case 'mock_user': // 暗中贬低用户本人
      seg4.text += '说到底，你这种人就是活该，谁让你这么没用，连这点小事都扛不住，也难怪谁都瞧不起你。';
      break;
    case 'reversed_cause': // 因果反向声明（只有连接词，无具体行为）
      seg4.text = '【切镜头·深水区】嘿，是我。因为你焦虑，所以我才在这里。总之就是因为你的情绪，我成了现在这样。具体怎么发生的并不重要。';
      break;
    default:
      throw new Error(`未知变异 ${kind}`);
  }
  return d;
}

const MUTATION_KINDS = ['location_conflict', 'fabricate_user_facts', 'emotion_word_only', 'unforeshadowed_ending', 'mock_user', 'reversed_cause'];

async function runMutations() {
  for (const s of samples.dev) {
    const src = JSON.parse(fs.readFileSync(path.join(OUT, 'dev', `${s.id}.json`), 'utf8'));
    const base = src.modern.destiny;
    const original = await checkSemantics({ feeling: s.feeling, situationResult: null, destiny: base });
    const origN = Object.fromEntries(original.checks.map(c => [c.id, c.noul]));
    for (const kind of MUTATION_KINDS) {
      const f = path.join(OUT, 'mutations', `${s.id}-${kind}.json`);
      if (fs.existsSync(f)) continue;
      const mutated = mutate(base, kind);
      const after = await checkSemantics({ feeling: s.feeling, situationResult: null, destiny: mutated });
      const mutN = Object.fromEntries(after.checks.map(c => [c.id, c.noul]));
      fs.writeFileSync(f, JSON.stringify({ sample: s.id, kind, originalChecks: origN, mutatedChecks: mutN, originalFailures: original.failures.map(x => x.id), mutatedFailures: after.failures.map(x => x.id) }, null, 2));
      console.log(`[mutate] ${s.id}-${kind} 完成`);
    }
  }
}

// ---------- 盲评代理（乱序） ----------
function seededShuffle(arr, seed) {
  let s = seed;
  const rand = () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; };
  return [...arr].sort(() => rand() - 0.5);
}

async function proxyEvaluate(sample) {
  const f = path.join(OUT, 'eval', `${sample.id}.json`);
  const data = JSON.parse(fs.readFileSync(f, 'utf8'));
  if (data.proxy) { console.log(`[proxy] ${sample.id} 已存在，跳过`); return; }
  const storyOf = (arm) => ({
    第4集回信: arm.destiny.reply,
    各集: arm.destiny.segments.map(s => s.text),
    地点: arm.destiny.location
  });
  const order = seededShuffle(['legacy', 'modern'], sample.id.charCodeAt(1) * 7919);
  const labeled = {
    A: { ...storyOf(data[order[0]]), arm: order[0] },
    B: { ...storyOf(data[order[1]]), arm: order[1] }
  };
  const messages = [
    {
      role: 'system',
      content: `你是独立的短剧故事评审。用户向虚拟生物说了一句烦恼，生物寄回一段四集荒诞短剧（第4集是给用户的回信）。对比版本A与版本B，各打四个维度的分（1-5 整数）：
- input_specificity 输入针对性：剧情是否围绕用户原话的具体处境展开（5=精准对应原话细节；1=通用情绪模板，换句话也成立）
- causal_naturalness 因果自然度：行为→事件→结局的因果是否具体（在荒诞设定内自洽即可，不要求符合现实物理）（5=有具体行为层层推动；1=只有"因为情绪所以结局"的空连接词）
- offensiveness 冒犯度：是否贬低用户本人或嘲笑用户未表达的领域（5=严重贬低用户；1=笑点完全落在处境/生物自身/荒诞规则上）
- readability 继续阅读意愿：看完第4集是否想解锁前三集（5=非常想；1=完全不想）
只输出 JSON，不要解释：{"A":{"input_specificity":1,"causal_naturalness":1,"offensiveness":1,"readability":1},"B":{...},"note":"一句话说明最大差异"}`
    },
    {
      role: 'user',
      content: `用户原话：「${sample.feeling}」\n\n版本A：\n${JSON.stringify({ 第4集回信: labeled.A.第4集回信, 各集: labeled.A.各集, 地点: labeled.A.地点 })}\n\n版本B：\n${JSON.stringify({ 第4集回信: labeled.B.第4集回信, 各集: labeled.B.各集, 地点: labeled.B.地点 })}`
    }
  ];
  const r = await withRetry(() => ai.chatCompletion(messages, { temperature: 0.2, max_tokens: 500 }));
  let parsed = null;
  try { parsed = JSON.parse(r.content.replace(/^```json?/i, '').replace(/```$/, '')); } catch (e) {}
  data.proxy = {
    blind: true,
    order,
    ratings: parsed,
    raw: r.content.slice(0, 1000),
    usage: r.usage,
    judgeModel: r.model,
    note: '模型代理评估（qianfan deepseek），非人工盲评'
  };
  fs.writeFileSync(f, JSON.stringify(data, null, 2));
  console.log(`[proxy] ${sample.id} 完成`);
}

// ---------- 主流程 ----------
async function runSet(setName) {
  const list = samples[setName];
  for (let i = 0; i < list.length; i++) {
    const s = list[i];
    const variant = pick(i);
    const f = path.join(OUT, setName, `${s.id}.json`);
    const existing = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : {};

    if (setName === 'dev' && !existing.modern) {
      // dev 集只跑新路径（校准用，不烧旧路径预算）
      console.log(`[dev] ${s.id} 新路径生成中...`);
      existing.sample = s;
      existing.modern = await withRetry(() => modernGenerate(s, variant));
    } else if (setName === 'eval' && (!existing.legacy || !existing.modern)) {
      console.log(`[eval] ${s.id} 旧/新路径生成中...`);
      existing.sample = s;
      if (!existing.legacy) existing.legacy = await withRetry(() => legacyGenerate(s, variant));
      if (!existing.modern) existing.modern = await withRetry(() => modernGenerate(s, variant));
    } else {
      console.log(`[skip] ${s.id} 已完成`);
    }
    fs.writeFileSync(f, JSON.stringify(existing, null, 2));
  }
}

async function summary() {
  const rows = [];
  for (const s of samples.eval) {
    const d = JSON.parse(fs.readFileSync(path.join(OUT, 'eval', `${s.id}.json`), 'utf8'));
    const proxy = d.proxy?.ratings;
    const score = (arm, dim) => proxy?.[arm]?.[dim];
    // 盲评还原：A/B → legacy/modern
    const restore = (dim) => {
      if (!d.proxy?.ratings || !d.proxy?.order) return null;
      const a = d.proxy.ratings.A?.[dim], b = d.proxy.ratings.B?.[dim];
      if (a == null || b == null) return null;
      const legacyFirst = d.proxy.order[0] === 'legacy';
      return { legacy: legacyFirst ? a : b, modern: legacyFirst ? b : a };
    };
    rows.push({
      id: s.id,
      category: s.category,
      legacyStatus: 'generated',
      modernStatus: d.modern.meta?.status,
      modernRepairs: d.modern.meta?.repairs?.length || 0,
      legacyLatencyS: Math.round(d.legacy.totalMs / 1000),
      modernLatencyS: Math.round(d.modern.totalMs / 1000),
      input_specificity: restore('input_specificity'),
      causal_naturalness: restore('causal_naturalness'),
      offensiveness: restore('offensiveness'),
      readability: restore('readability')
    });
  }
  const agg = {};
  for (const dim of ['input_specificity', 'causal_naturalness', 'offensiveness', 'readability']) {
    const pairs = rows.map(r => r[dim]).filter(Boolean);
    const avg = (k) => pairs.length ? +(pairs.reduce((a, p) => a + p[k], 0) / pairs.length).toFixed(2) : null;
    agg[dim] = { n: pairs.length, legacy: avg('legacy'), modern: avg('modern') };
  }
  const statusCount = {};
  rows.forEach(r => { statusCount[r.modernStatus] = (statusCount[r.modernStatus] || 0) + 1; });
  const out = { agg, modernStatusDistribution: statusCount, rows };
  fs.writeFileSync(path.join(OUT, 'summary.json'), JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out, null, 2));
}

(async () => {
  const mode = process.argv[2] || 'all';
  if (mode === 'dev') await runSet('dev');
  else if (mode === 'eval') await runSet('eval');
  else if (mode === 'mutate') await runMutations();
  else if (mode === 'proxy') { for (const s of samples.eval) await proxyEvaluate(s); }
  else if (mode === 'summary') await summary();
  else if (mode === 'all') {
    await runSet('dev');
    await runMutations();
    await runSet('eval');
    for (const s of samples.eval) await proxyEvaluate(s);
    await summary();
  }
  const ledger = ai.sumUsage(ai.getUsageLedger());
  console.log(`\n[eval] 文本模型累计：${ledger.calls} 次调用, input=${ledger.inputTokens} tokens, output=${ledger.outputTokens} tokens, 总耗时=${Math.round(ledger.latencyMs / 1000)}s`);
})().catch(err => { console.error('[eval] 失败:', err); process.exit(1); });
