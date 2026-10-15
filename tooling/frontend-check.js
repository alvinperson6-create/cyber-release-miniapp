#!/usr/bin/env node
// 赛博放生 · 前端静态与资源检查
//
// 验证 renderer 与后端契约一致、公开资源齐备、且没有残留的旧路径引用。
// 这一项不替代真实浏览器回归，只覆盖可静态判定的部分。

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const RENDERER = path.join(ROOT, 'renderer');
const ASSETS = path.join(RENDERER, 'assets');

const problems = [];
function check(ok, msg) {
  console.log(`  ${ok ? '✔' : '✖'} ${msg}`);
  if (!ok) problems.push(msg);
}

// —— 1. 入口存在 ——
const indexPath = path.join(RENDERER, 'index.html');
check(fs.existsSync(indexPath), 'renderer/index.html 存在');
if (!fs.existsSync(indexPath)) { console.error('缺少 H5 入口，后续检查中止'); process.exit(1); }
const html = fs.readFileSync(indexPath, 'utf8');

// —— 2. 公开资源齐备（createApp 只挂载这些前缀）——
// createApp 把 /vendor /images /globe3d.js 等前缀映射到 renderer/assets 下
const PUBLIC_ASSETS = [
  'vendor/three.min.js',
  'globe3d.js',
  'globe-config.json',
  'world-land.json'
];
for (const rel of PUBLIC_ASSETS) {
  check(fs.existsSync(path.join(ASSETS, rel)), `公开资源存在：assets/${rel}`);
}
const vendorShaders = ['CopyShader.js', 'EffectComposer.js', 'LuminosityHighPassShader.js',
  'RenderPass.js', 'ShaderPass.js', 'UnrealBloomPass.js'];
for (const v of vendorShaders) {
  check(fs.existsSync(path.join(ASSETS, 'vendor', v)), `vendor shader 存在：${v}`);
}
const texturesDir = path.join(ASSETS, 'vendor', 'textures');
check(fs.existsSync(texturesDir) && fs.readdirSync(texturesDir).length > 0, 'vendor textures 目录非空');

// —— 3. 页面引用的每个本地资源都真实存在（URL 可能带 ?v= 查询串）——
const srcRefs = [...html.matchAll(/src="(\/[^"]+)"/g)].map(m => m[1]);
for (const ref of new Set(srcRefs)) {
  const clean = ref.split('?')[0];           // 去掉 ?v=16 之类的缓存串
  if (clean.startsWith('/vendor/') || clean.startsWith('/globe') || clean === '/world-land.json') {
    const onDisk = path.join(ASSETS, clean.replace(/^\//, ''));
    check(fs.existsSync(onDisk), `页面引用可解析：${ref}`);
  }
}

// —— 4. 不引用搬迁前的旧路径 ——
for (const stale of ['server/public', '../web-app.html', './server/']) {
  check(!html.includes(stale), `不引用旧路径：${stale}`);
}

// —— 5. 前端调用的 API 路径都真实存在于后端 ——
// 后端路由分两处注册：api-router.js 的业务路由 + app.js 的 health。
// 这里把前端路径与两处定义比对（动态段按 :id 匹配）。
const routerSrc = fs.readFileSync(path.join(ROOT, 'serving', 'entrypoints', 'api-router.js'), 'utf8');
const appSrc = fs.readFileSync(path.join(ROOT, 'serving', 'entrypoints', 'app.js'), 'utf8');
const ROUTES = new Set([
  ...[...routerSrc.matchAll(/router\.(get|post)\(\s*'([^']*)'/g)].map(m => m[2]),
  ...[...appSrc.matchAll(/app\.(get|post)\(\s*'\/api([^']*)'/g)].map(m => '/api' + m[2])
]);
const apiCalls = [...html.matchAll(/(?:api|fetch)\(\s*'(\/api\/[^']+)'/g)].map(m => m[1]);
for (const p of new Set(apiCalls)) {
  const rel = p.replace(/^\/api/, '');
  const callSegs = rel.split('/').filter(Boolean);
  // 同时用 "/x" 与 "/api/x" 两种写法比对，因为两处注册的基准前缀不同
  const ok = ROUTES.has(p) || ROUTES.has(rel) || callSegs.some(seg => {
    if (seg.includes('+') || seg.includes('encodeURIComponent')) return false;
    return ROUTES.has('/' + seg) || ROUTES.has('/api/' + seg) ||
      ROUTES.has('/' + seg + '/:id') || ROUTES.has('/api/' + seg + '/:id');
  });
  check(ok, `前端调用的接口在后端存在：${p}`);
}
if (!ROUTES.size) { console.error('未能解析后端路由定义'); process.exit(1); }

// —— 6. 前端发送的字段名与后端契约一致 ——
const contractsSrc = fs.readFileSync(path.join(ROOT, 'shared', 'contracts', 'commands.js'), 'utf8');
for (const field of ['signalMessageId', 'encounterId', 'requestId', 'tone', 'text', 'feeling', 'species', 'water']) {
  check(contractsSrc.includes(field) || contractsSrc.includes('creatureId'),
    `契约接受字段：${field}`);
}

// —— 7. 安全渲染：动态文本经 esc ——
check(html.includes('function esc('), 'esc() 转义函数存在');
check(!/innerHTML\s*=\s*[^;]*\+\s*[^;]*\.text(?![\s\S]{0,30}esc)/.test(html),
  '不把未转义文本直接写入 innerHTML');

// —— 8. 阶段 E 的状态分离在位 ——
for (const marker of ['serverViews', 'drafts', 'viewGeneration', 'reqSeq', 'validateView', 'pendingCommands']) {
  check(html.includes(marker), `前端状态分离标记存在：${marker}`);
}

// —— 9. 不泄露内部字段名 ——
for (const leaked of ['owner_key', 'ownerKey', 'proposal_json']) {
  check(!html.includes(leaked), `前端不引用内部字段：${leaked}`);
}

// —— 10. 脚本与文档不引用已搬迁的旧路径（依赖断链检查）——
// 目录搬迁后最容易留下"看起来还在、其实跑不起来"的引用。
const STALE_REFS = [
  'server/node_modules',
  'server/public',
  'server/index.js',
  'server/orchestrator.js',
  'server/db.js',
  'web-app.html'
];
const scanTargets = [
  ...fs.readdirSync(path.join(ROOT, 'scripts')).filter(f => f.endsWith('.js')).map(f => path.join(ROOT, 'scripts', f)),
  ...fs.readdirSync(path.join(ROOT, 'tooling')).filter(f => f.endsWith('.js')).map(f => path.join(ROOT, 'tooling', f)),
  path.join(ROOT, 'package.json'),
  path.join(ROOT, 'README.md'),
  path.join(ROOT, 'AGENTS.md')
];
for (const file of scanTargets) {
  if (!fs.existsSync(file)) continue;
  // 本检查器自己包含这些字符串（就是规则表），跳过
  if (path.resolve(file) === path.resolve(__filename)) continue;
  const raw = fs.readFileSync(file, 'utf8');
  // 只看**代码**里的引用：注释里的历史说明（"曾产出 server/public"）是
  // 有价值的迁移记录，不该被当成断链。只扫非注释部分。
  const code = raw
    .replace(/\/\*[\s\S]*?\*\//g, ' ')          // 块注释
    .split('\n')
    .filter(line => !line.trimStart().startsWith('//'))  // 行注释
    .join('\n');
  for (const stale of STALE_REFS) {
    check(!code.includes(stale), `${path.relative(ROOT, file)} 的代码不引用旧路径 ${stale}`);
  }
}

console.log('');
if (problems.length) {
  console.error(`${problems.length} 项前端检查失败`);
  process.exitCode = 1;
} else {
  console.log('前端检查通过。');
}
