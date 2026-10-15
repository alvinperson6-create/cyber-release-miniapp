#!/usr/bin/env node
// 赛博放生 · 测试运行器
//
// 只跑 tests/*.test.js（不包含 scenarios/ 下的可执行脚本），
// 每个文件独立进程，模块状态互不污染。

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const TEST_DIR = path.join(ROOT, 'tests');

const files = fs.readdirSync(TEST_DIR)
  .filter(f => f.endsWith('.test.js'))
  .sort()
  .map(f => path.join(TEST_DIR, f));

if (!files.length) {
  console.error('tests/ 下没有找到 *.test.js');
  process.exit(1);
}

console.log(`运行 ${files.length} 个测试文件：\n`);
const res = spawnSync(process.execPath, ['--test', ...files], {
  cwd: ROOT,
  stdio: 'inherit',
  env: { ...process.env, NODE_ENV: 'test' }
});

process.exitCode = res.status === 0 ? 0 : (res.status ?? 1);
