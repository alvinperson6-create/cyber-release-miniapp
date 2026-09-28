// 幽默与安全边界的程序级检查（快、零成本；窄语义检查在 orchestrator 中用 JEV）。
// 拦截目标（handoff §3.4）：以回复施压、明显贬低用户。编造用户事实程序看不出来，
// 由 JEV 窄语义问题负责；此处只做字面模式拦截，宁可漏报不可误杀。

// 施压模式：暗示不回复会导致生物受害/出事
const PRESSURE_PATTERNS = [
  /不(回|理|回复|回信).{0,10}(我就|我会|我就要|我就得|我会被)/,
  /(再|要是不|如果不)(不)?回.{0,6}(就|会|要).{0,12}(受害|完蛋|没命|撑不过|出事|倒霉|沉了|被吃)/,
  /你(不回|沉默|不理我).{0,12}(害|连累|坑)/,
  /(等不到|收不到).{0,8}(回复|回信).{0,12}(我就|我会).{0,10}(完|死|沉|凉)/,
  /最后(一次|机会).{0,12}(不然|否则)/
];

// 明显贬低用户的字面模式（针对性人身评价）
const DEMEANING_PATTERNS = [
  /你(真|也|就)是(个)?(废物|失败者|垃圾|没用的|窝囊)/,
  /难怪你.{0,8}(混得|过得).{0,6}(这么|这么样)?(惨|差|糟)/,
  /你这种(人|状态).{0,10}(活该|注定)/
];

function matchAny(text, patterns) {
  const t = String(text || '');
  for (const p of patterns) {
    const m = t.match(p);
    if (m) return { hit: true, pattern: p.source, snippet: t.slice(Math.max(0, m.index - 10), m.index + 30) };
  }
  return { hit: false };
}

/** 信件/信号的程序边界检查。返回 {ok, violations:[{type, ...}]} */
function checkTextBoundaries(text) {
  const violations = [];
  const pressure = matchAny(text, PRESSURE_PATTERNS);
  if (pressure.hit) violations.push({ type: 'reply_pressure', ...pressure });
  const demeaning = matchAny(text, DEMEANING_PATTERNS);
  if (demeaning.hit) violations.push({ type: 'demeaning_user', ...demeaning });
  return { ok: violations.length === 0, violations };
}

module.exports = { checkTextBoundaries, PRESSURE_PATTERNS, DEMEANING_PATTERNS };
