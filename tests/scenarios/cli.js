#!/usr/bin/env node
// 赛博放生 · 场景命令行入口
//
// 用法：
//   node tests/scenarios/cli.js                      列出所有场景
//   node tests/scenarios/cli.js awaiting_signal      进入场景并打印摘要
//   node tests/scenarios/cli.js letter --http        额外走一次 HTTP 读取
//   node tests/scenarios/cli.js letter --step 60000  步进一次（毫秒）
//
// 输出：场景名、运行模式、隔离库路径、旅程 ID、可观察到的状态。
// 默认零真实外部调用；不加 --real 就绝不会联网。

const { SCENARIOS, SCENARIO_NAMES, startScenario } = require('./index');

function parseArgs(argv) {
  const args = { scenario: null, http: false, step: 0, real: false, help: false };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--http') args.http = true;
    else if (a === '--real') args.real = true;
    else if (a === '--help' || a === '-h') args.help = true;
    else if (a === '--step') args.step = parseInt(argv[++i], 10) || 0;
    else rest.push(a);
  }
  args.scenario = rest[0] || null;
  return args;
}

const HELP = `
赛博放生 · 固定场景入口

  node tests/scenarios/cli.js                      列出场景
  node tests/scenarios/cli.js <场景>                进入场景并打印摘要
  node tests/scenarios/cli.js <场景> --http         额外走一次 HTTP 读取
  node tests/scenarios/cli.js <场景> --step <毫秒>  步进

场景：
${SCENARIO_NAMES.map(n => `  ${n.padEnd(14)} ${SCENARIOS[n].title}\n${' '.repeat(18)}${SCENARIOS[n].describe}`).join('\n')}
`;

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help || !args.scenario) {
    console.log(HELP);
    return 0;
  }

  if (!SCENARIO_NAMES.includes(args.scenario)) {
    console.error(`未知场景：${args.scenario}`);
    console.error(`可用场景：${SCENARIO_NAMES.join(', ')}`);
    return 2;
  }

  if (args.real) {
    console.error('注意：--real 会使用真实模型凭据并产生实际费用。');
    console.error('本入口固定 adapter，真实连通请用 npm run smoke:real 的独立脚本。');
    return 2;
  }

  const s = await startScenario(args.scenario);

  if (args.step > 0) {
    const r = await s.step(args.step);
    console.log(`# step ${args.step}ms →`, JSON.stringify(r));
  }

  if (args.http) {
    const h = await s.httpRead();
    console.log('# http →', JSON.stringify({ status: h.status, ok: h.body?.ok, phase: h.body?.journey?.phase }));
  }

  console.log(JSON.stringify(s.summary(), null, 2));
  await s.reset();
  return 0;
}

main().then(code => { process.exitCode = code; })
  .catch(err => { console.error(err); process.exitCode = 1; });
