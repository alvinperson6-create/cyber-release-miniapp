#!/usr/bin/env node
// 赛博放生 · 统一检查入口
//
// 阶段 F 的要求：根目录一个命令跑完所有必要检查，失败返回非零，
// 并指出是哪一项检查、哪个场景、产物在哪。
//
// 默认不需要真实模型、生产数据或付费服务。
// 真实连通是独立命令（npm run smoke:real），不会混进默认检查。

const { spawnSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.resolve(__dirname, '..');
const NODE = process.execPath;

const args = process.argv.slice(2);
const FAST = args.includes('--fast');

const CHECKS = [
  {
    id: 'boundaries',
    title: '依赖边界',
    desc: 'shared/renderer/serving 之间的硬约束（含检查器自测）',
    cmd: [NODE, [path.join(ROOT, 'tooling', 'boundary-check.js'), '--self-test']],
    critical: true
  },
  {
    id: 'contracts',
    title: '共享契约',
    desc: '契约纯度：shared 不含 IO/env，命令校验与错误码可用',
    cmd: [NODE, [path.join(ROOT, 'tooling', 'contracts-check.js')]],
    critical: true
  },
  {
    id: 'unit',
    title: '离线业务与装配',
    desc: '存储/旅程/竞态/装配/HTTP/前端/代理的 node:test 套件（零真实外部调用）',
    cmd: [NODE, [
      '--test',
      ...['store', 'journey-core', 'race-and-guards', 'app-assembly',
           'http-contract', 'frontend-contract', 'proxy-client']
        .map(n => path.join(ROOT, 'tests', `${n}.test.js`))
    ]],
    critical: true
  },
  {
    id: 'scenarios',
    title: '固定场景',
    desc: '每个固定场景都能进入并达到预期状态',
    cmd: [NODE, [path.join(ROOT, 'tests', 'scenarios', 'verify-all.js')]],
    critical: true
  },
  {
    id: 'frontend',
    title: '前端静态与资源',
    desc: 'H5 入口存在、公共资源可达、脚本与后端契约一致',
    cmd: [NODE, [path.join(ROOT, 'tooling', 'frontend-check.js')]],
    critical: true
  }
];

const FAST_IDS = new Set(['boundaries', 'contracts']);

function run(check) {
  const [bin, argv] = check.cmd;
  const started = Date.now();
  const res = spawnSync(bin, argv, {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, NODE_ENV: 'test' },
    maxBuffer: 32 * 1024 * 1024
  });
  return {
    ok: res.status === 0,
    status: res.status,
    stdout: res.stdout || '',
    stderr: res.stderr || '',
    ms: Date.now() - started
  };
}

function main() {
  const list = FAST ? CHECKS.filter(c => FAST_IDS.has(c.id)) : CHECKS;
  console.log(`赛博放生 · 统一检查${FAST ? '（快速子集）' : ''}\n`);

  const results = [];
  let failed = 0;

  for (const check of list) {
    process.stdout.write(`▸ ${check.title.padEnd(12, '　')} ${check.desc}\n`);
    const r = run(check);
    results.push({ check, r });

    if (r.ok) {
      const summary = (r.stdout.match(/^ℹ pass (\d+)/m) || [])[1];
      const extra = summary ? `（${summary} 项断言通过）` : '';
      console.log(`  ✔ 通过 ${r.ms}ms${extra}\n`);
    } else {
      failed++;
      console.log(`  ✖ 失败 ${r.ms}ms（退出码 ${r.status}）\n`);
      const detail = (r.stderr || r.stdout || '').trimEnd();
      if (detail) console.log(detail.split('\n').map(l => `    ${l}`).join('\n'));
      console.log('');
      if (check.critical && !FAST) {
        console.log(`  → 关键检查「${check.title}」失败，后续检查已中止。\n`);
        break;
      }
    }
  }

  console.log('─'.repeat(60));
  const passed = results.filter(x => x.r.ok).length;
  console.log(`检查结果：${passed}/${results.length} 项通过`);

  if (failed) {
    console.log('\n失败项：');
    for (const { check, r } of results.filter(x => !x.r.ok)) {
      console.log(`  · ${check.id} (${check.title}) — 退出码 ${r.status}`);
    }
    console.log('\n产物位置：');
    console.log('  · 场景数据库：系统临时目录 cyber-release-*（每次运行新建，运行后残留便于排查）');
    console.log('  · 详细证据：docs/agent-environment-validation.md');
    process.exitCode = 1;
    return;
  }
  console.log('\n全部通过。');
}

main();
