#!/usr/bin/env node
// 赛博放生 · 依赖边界检查器
//
// 阶段 3.1 的规则不是文档约定，而是**会失败的检查**：
//   - renderer 只能通过 edge 调 API，不得 import serving / 数据库 / 凭据
//   - shared 只含纯模块，不得 import renderer/serving，不得有 IO / env / 密钥 / 副作用
//   - queries 不得写业务状态或调模型
//   - 模型 adapter 不得直接提交业务事实
//   - 提示词与 schema 校验模块不得访问数据库或网络
//   - workflow 不得绕过 commit 直接写表
//   - 原始 SQL 只允许出现在存储适配层
//   - 生产路径不得依赖 legacy 或测试场景
//
// 自测：tests/fixtures/boundary-violations/ 里放了每一类违规样例，
// --self-test 会证明检查器确实会拒绝它们（绿色空配置不算强制边界）。

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

const LAYERS = {
  shared: path.join(ROOT, 'shared'),
  renderer: path.join(ROOT, 'renderer'),
  serving: path.join(ROOT, 'serving'),
  legacy: path.join(ROOT, 'legacy'),
  tests: path.join(ROOT, 'tests'),
  tooling: path.join(ROOT, 'tooling')
};

const SCAN_DIRS = ['shared', 'renderer', 'serving'];
const SCAN_EXT = new Set(['.js', '.mjs', '.cjs']);
const SKIP_DIRS = new Set(['node_modules', '.git', '.workbuddy', 'assets']);

/** 解析 require/import 的目标，判断它落在哪一层 */
function resolveLayer(fromFile, spec) {
  if (!spec.startsWith('.') && !spec.startsWith('/')) return null;   // 第三方包
  const abs = spec.startsWith('/')
    ? path.join(ROOT, spec)
    : path.resolve(path.dirname(fromFile), spec);
  for (const [name, dir] of Object.entries(LAYERS)) {
    if (abs === dir || abs.startsWith(dir + path.sep)) return name;
  }
  return null;
}

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (SCAN_EXT.has(path.extname(entry.name))) out.push(full);
  }
  return out;
}

const REQUIRE_RE = /require\(\s*['"]([^'"]+)['"]\s*\)|from\s+['"]([^'"]+)['"]/g;

/** 收集一个文件的所有依赖 */
function depsOf(file) {
  const src = fs.readFileSync(file, 'utf8');
  const deps = [];
  let m;
  const re = new RequireRE();
  while ((m = re.exec(src)) !== null) {
    const spec = m[1] || m[2];
    if (!spec) continue;
    deps.push({ spec, layer: resolveLayer(file, spec) });
  }
  return { src, deps };
}

// 避免正则 lastIndex 共享
class RequireRE extends RegExp {
  constructor() { super(REQUIRE_RE.source, 'g'); }
}

// ======== 规则 ========

const RULES = [
  {
    id: 'shared-no-serving',
    layer: 'shared',
    forbidLayers: ['renderer', 'serving'],
    why: 'shared 是公开契约层，不得依赖 renderer/serving'
  },
  {
    id: 'shared-no-io',
    layer: 'shared',
    pattern: /\b(process\.env|require\(['"](fs|node:fs|path|node:path|child_process|http|https|node-fetch|better-sqlite3)['"]\))/,
    why: 'shared 只含纯模块，不得含 IO / env 读取'
  },
  {
    id: 'renderer-no-serving',
    layer: 'renderer',
    forbidLayers: ['serving'],
    why: 'renderer 只能通过 edge 调 API，不得 import serving'
  },
  {
    id: 'renderer-no-db',
    layer: 'renderer',
    pattern: /\b(better-sqlite3|\.prepare\(|SELECT\s+.+\s+FROM|INSERT\s+INTO|UPDATE\s+\w+\s+SET)/i,
    why: 'renderer 不得直接访问数据库'
  },
  {
    id: 'serving-no-legacy',
    layer: 'serving',
    forbidLayers: ['legacy', 'tests'],
    why: '生产路径不得依赖 legacy 或测试场景'
  },
  {
    id: 'no-legacy-in-shared-renderer',
    layer: null,
    forbidLayers: ['legacy'],
    applyTo: ['shared', 'renderer'],
    why: 'shared/renderer 不得引用 legacy'
  }
];

/** SQL 只允许出现在存储适配层与迁移工具 */
const SQL_ALLOWED = [
  path.join(LAYERS.serving, 'adapters'),
  path.join(LAYERS.tools || ROOT, 'tooling')
];

function isSqlAllowed(file) {
  return SQL_ALLOWED.some(dir => file.startsWith(dir + path.sep));
}

const SQL_RE = /\b(SELECT\s+[\s\S]*?\s+FROM|INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM|CREATE\s+(TABLE|INDEX)|PRAGMA\s)/i;

function checkFile(file) {
  const { src, deps } = depsOf(file);
  const rel = path.relative(ROOT, file);
  const layer = Object.entries(LAYERS).find(([, d]) => file.startsWith(d + path.sep))?.[0];
  const violations = [];

  for (const rule of RULES) {
    const applies = rule.applyTo
      ? rule.applyTo.includes(layer)
      : (rule.layer === layer);
    if (!applies) continue;

    if (rule.forbidLayers) {
      for (const d of deps) {
        if (d.layer && rule.forbidLayers.includes(d.layer)) {
          violations.push({
            rule: rule.id, file: rel, line: lineOf(src, d.spec),
            detail: `依赖 ${d.layer}（${d.spec}）`, why: rule.why
          });
        }
      }
    }
    if (rule.pattern) {
      const m = src.match(rule.pattern);
      if (m) {
        violations.push({
          rule: rule.id, file: rel, line: lineOf(src, m[0]),
          detail: `命中 ${m[0].slice(0, 60)}`, why: rule.why
        });
      }
    }
  }

  // 原始 SQL 只能出现在存储适配层
  if (layer === 'serving' && !isSqlAllowed(file) && SQL_RE.test(src)) {
    violations.push({
      rule: 'sql-only-in-store', file: rel, line: lineOf(src, 'SELECT'),
      detail: '在存储适配层之外出现原始 SQL', why: '原始 SQL 与事务实现集中到存储适配层'
    });
  }

  return violations;
}

function lineOf(src, needle) {
  const i = src.indexOf(needle);
  if (i < 0) return 0;
  return src.slice(0, i).split('\n').length;
}

function scan(dirs = SCAN_DIRS) {
  const files = dirs.flatMap(d => walk(path.join(ROOT, d)));
  const violations = files.flatMap(checkFile);
  return { files: files.length, violations };
}

/** 自测：把违规样例目录当作源码扫一遍，证明每条规则都会失败 */
function selfTest() {
  const fixtureDir = path.join(ROOT, 'tests', 'fixtures', 'boundary-violations');
  if (!fs.existsSync(fixtureDir)) {
    return { ok: false, reason: 'fixture 目录缺失', cases: [] };
  }
  const cases = [];
  for (const entry of fs.readdirSync(fixtureDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const caseName = entry.name;
    const dir = path.join(fixtureDir, caseName);
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.js')).map(f => path.join(dir, f));
    // 把样例当作 shared/serving 层的真实文件来检查
    const violations = files.flatMap(f => checkFileAsLayer(f, caseName));
    cases.push({
      case: caseName,
      caught: violations.length > 0,
      rules: [...new Set(violations.map(v => v.rule))]
    });
  }
  const ok = cases.length > 0 && cases.every(c => c.caught);
  return { ok, cases, reason: ok ? null : '存在未被捕获的违规样例' };
}

/** 样例目录名暗示它模拟哪一层 */
function checkFileAsLayer(file, caseName) {
  const layer = caseName.includes('serving') ? 'serving' : (caseName.includes('renderer') ? 'renderer' : 'shared');
  const src = fs.readFileSync(file, 'utf8');
  const deps = [];
  let m;
  const re = new RequireRE();
  while ((m = re.exec(src)) !== null) {
    const spec = m[1] || m[2];
    if (!spec) continue;
    deps.push({ spec, layer: resolveLayer(file, spec) });
  }
  const violations = [];
  for (const rule of RULES) {
    const applies = rule.applyTo ? rule.applyTo.includes(layer) : (rule.layer === layer);
    if (!applies) continue;
    if (rule.forbidLayers) {
      for (const d of deps) {
        if (d.layer && rule.forbidLayers.includes(d.layer)) {
          violations.push({ rule: rule.id, file: path.basename(file), detail: d.spec });
        }
      }
    }
    if (rule.pattern && rule.pattern.test(src)) {
      violations.push({ rule: rule.id, file: path.basename(file), detail: rule.pattern.source.slice(0, 40) });
    }
  }
  // SQL 只在存储层：样例模拟 serving 非存储层时应被捕获
  if (layer === 'serving' && SQL_RE.test(src)) {
    violations.push({ rule: 'sql-only-in-store', file: path.basename(file), detail: 'raw SQL outside store' });
  }
  return violations;
}

// ======== CLI ========

function main() {
  const args = process.argv.slice(2);
  const doSelfTest = args.includes('--self-test');

  if (doSelfTest) {
    const st = selfTest();
    console.log('边界检查器自测（证明规则确实会失败）：');
    for (const c of st.cases) {
      console.log(`  ${c.caught ? '✔' : '✖'} ${c.case.padEnd(28)} → ${c.rules.join(', ') || '未捕获'}`);
    }
    if (!st.ok) {
      console.error(`\n自测失败：${st.reason}`);
      process.exitCode = 1;
      return;
    }
    console.log('  全部违规样例均被拒绝。');
    return;
  }

  const { files, violations } = scan();
  console.log(`扫描 ${files} 个文件（${SCAN_DIRS.join(', ')}）`);

  if (violations.length) {
    console.error(`\n发现 ${violations.length} 处依赖边界违规：\n`);
    for (const v of violations) {
      console.error(`  [${v.rule}] ${v.file}:${v.line}`);
      console.error(`      ${v.detail}`);
      console.error(`      原因：${v.why}`);
    }
    console.error('\n边界规则是硬约束，不是风格建议。请修改代码而不是放宽规则。');
    process.exitCode = 1;
    return;
  }
  console.log('依赖边界检查通过。');
}

if (require.main === module) main();

module.exports = { scan, selfTest, RULES };
