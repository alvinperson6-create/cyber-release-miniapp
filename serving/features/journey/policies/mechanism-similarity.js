// 机制去重的程序级文本相似度：字符 bigram Jaccard（纯模块，无 IO）
//
// 去重对象是因果机制（压力—两难—代价—后果），不是道具/地点/行动标签。
// 相似度只做窄比较：clear（明显重播）/ suspicious（可疑，记日志抽样）/ ok。

function bigrams(text) {
  const t = String(text || '').toLowerCase().replace(/[\s，。、；；：""''！？!?,.:;'"()（）\-—_/\\]/g, '');
  const out = new Set();
  for (let i = 0; i < t.length - 1; i++) out.add(t.slice(i, i + 2));
  if (t.length === 1) out.add(t);
  return out;
}

function jaccard(a, b) {
  const A = bigrams(a), B = bigrams(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}

function compareWithCard(summary, card) {
  const fields = ['pressure', 'dilemma', 'cost'];
  const cardFields = ['pressure', 'dilemma', 'choice_cost'];
  const scores = fields.map((f, i) => jaccard(summary[f], card[cardFields[i]]));
  const avg = scores.reduce((x, y) => x + y, 0) / scores.length;
  const strong = scores.filter(x => x >= 0.72).length;
  return { scores, avg, strong };
}

/**
 * 与最近机制卡比较。
 * @returns {{verdict:'clear'|'suspicious'|'ok', matchedCardId?:number, avg:number}}
 */
function compareSummary(summary, recentCards, { clearAvg = 0.55, clearStrong = 2, suspiciousAvg = 0.38 } = {}) {
  let best = null;
  for (const card of recentCards) {
    const r = compareWithCard(summary, card);
    if (!best || r.avg > best.avg) best = { ...r, card };
  }
  if (!best) return { verdict: 'ok', avg: 0 };
  if (best.avg >= clearAvg || best.strong >= clearStrong) {
    return { verdict: 'clear', matchedCardId: best.card.id, avg: best.avg };
  }
  if (best.avg >= suspiciousAvg) {
    return { verdict: 'suspicious', matchedCardId: best.card.id, avg: best.avg };
  }
  return { verdict: 'ok', avg: best.avg };
}

module.exports = { bigrams, jaccard, compareWithCard, compareSummary };
