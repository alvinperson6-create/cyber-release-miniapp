#!/usr/bin/env node
// 赛博放生 · 共享契约检查
//
// 契约层是浏览器与服务共用的单一来源，因此必须能被独立验证：
//   - shared 是纯模块：导入它不会碰文件系统、环境变量或网络
//   - 命令校验对每类非法输入给出契约里定义的状态码
//   - DTO 校验能拒绝非法响应（前端据此不写缓存）
//   - 每个错误码都有确定的状态码

const assert = require('node:assert');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const contracts = require(path.join(ROOT, 'shared', 'contracts'));

// —— 1. shared 必须是纯模块：导入前后 env 与文件系统状态不变 ——
const fs = require('node:fs');
const envBefore = JSON.stringify(Object.keys(process.env).sort());
const sharedFiles = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (p.endsWith('.js')) sharedFiles.push(p);
  }
})(path.join(ROOT, 'shared'));

for (const f of sharedFiles) require(f);

assert.strictEqual(
  JSON.stringify(Object.keys(process.env).sort()), envBefore,
  '导入 shared 契约不应新增环境变量'
);
console.log(`  ✔ shared 为纯模块（${sharedFiles.length} 个文件，导入未改变环境）`);

// —— 2. shared 不含 IO / env / 密钥 ——
const FORBIDDEN = [
  [/\bprocess\.env\b/, '读取 process.env'],
  [/require\(\s*['"]node:?(fs|path|child_process|http|https|net|tls|dgram)['"]\s*\)/, '引入 Node IO 模块'],
  [/\bnew\s+Database\b/, '直接使用数据库'],
  [/fetch\s*\(/, '发起网络请求']
];
let purity = 0;
for (const f of sharedFiles) {
  const src = fs.readFileSync(f, 'utf8');
  for (const [re, why] of FORBIDDEN) {
    if (re.test(src)) {
      console.error(`  ✖ ${path.relative(ROOT, f)}：${why}`);
      purity++;
    }
  }
}
assert.strictEqual(purity, 0, 'shared 契约层必须保持纯净');
console.log('  ✔ shared 不含 IO / env / 数据库 / 网络');

// —— 3. 命令校验：非法输入 → 契约里定义的状态码 ——
const cases = [
  // [命令, 输入, 期望 code]
  ['release', { species: 'dragon', water: 'xihu', feeling: 'x' }, 'invalid_species'],
  ['release', { species: 'koi', water: 'nowhere', feeling: 'x' }, 'invalid_water'],
  ['release', { species: 'koi', water: 'xihu', feeling: '  ' }, 'empty_feeling'],
  ['release', { species: 'koi', water: 'xihu', feeling: 'x'.repeat(501) }, 'feeling_too_long'],
  ['release', { species: 'koi', water: 'xihu', feeling: 'x', tone: 'angry' }, 'invalid_tone'],
  ['replyToSignal', { text: '' }, 'empty_reply'],
  ['replyToSignal', { text: 'x'.repeat(121), signalMessageId: 'm' }, 'reply_too_long'],
  ['replyToSignal', { text: '好' }, 'missing_reply_target'],   // 关键：缺目标必须拒绝
  ['setTone', { tone: 'weird' }, 'invalid_tone']
];
for (const [op, input, expected] of cases) {
  const r = contracts.PARSERS[op](input);
  assert.ok(!r.ok, `${op}(${JSON.stringify(input).slice(0, 40)}) 应失败`);
  assert.strictEqual(r.code, expected,
    `${op} 期望 ${expected}，实际 ${r.code}`);
}
console.log(`  ✔ 命令校验：${cases.length} 类非法输入都映射到契约错误码`);

// —— 4. requestId 规范 ——
for (const bad of ['short', 'has space', 'a'.repeat(200), '../../etc']) {
  const r = contracts.normalizeRequestId(bad);
  assert.ok(!r.ok, `非法 requestId 应被拒绝：${bad}`);
}
assert.ok(contracts.normalizeRequestId('req-abc12345').ok);
console.log('  ✔ requestId 只接受安全字符且限长');

// —— 5. 合法输入通过 ——
const good = contracts.parseReplyCommand({ text: '你可以答应它', signalMessageId: 'MSG-1', requestId: 'req-00000001' });
assert.ok(good.ok);
assert.strictEqual(good.value.signalMessageId, 'MSG-1');
assert.strictEqual(good.value.encounterId, null);
console.log('  ✔ 合法命令通过解析');

// —— 6. 错误码 → HTTP 状态码确定且合理 ——
for (const [code, def] of Object.entries(contracts.ERROR_CODES)) {
  assert.ok(Number.isInteger(def.http) && def.http >= 400 && def.http < 600,
    `${code} 的状态码不合法：${def.http}`);
  assert.ok(def.message && def.message.length > 0, `${code} 缺少对外消息`);
}
// 归属类一律 404（不泄露"存在但不是你"）
for (const code of ['journey_not_found', 'creature_not_found', 'signal_not_found', 'encounter_not_found']) {
  assert.strictEqual(contracts.ERROR_CODES[code].http, 404, `${code} 必须是 404`);
}
console.log(`  ✔ ${Object.keys(contracts.ERROR_CODES).length} 个错误码都有确定状态码；归属类统一 404`);

// —— 7. DTO 校验能拒绝非法响应 ——
const validView = {
  id: 'J1', status: 'active', phase: 'journeying', tone: 'balanced',
  messages: [], serverTime: 1000
};
assert.ok(contracts.validateJourneyView(validView).ok);

for (const [mutate, why] of [
  [v => { delete v.id; }, '缺 id'],
  [v => { v.phase = '不存在的阶段'; }, '未知 phase'],
  [v => { v.messages = 'not-array'; }, 'messages 非数组'],
  [v => { v.messages = [{ id: 'm1', kind: 'unknown_kind', text: 'x' }]; }, '未知消息 kind'],
  [v => { delete v.serverTime; }, '缺 serverTime'],
  [v => { v.pendingSignal = { encounterId: 'e' }; }, 'pendingSignal 缺字段']
]) {
  const v = JSON.parse(JSON.stringify(validView));
  mutate(v);
  const r = contracts.validateJourneyView(v);
  assert.ok(!r.ok, `非法响应应被拒绝：${why}`);
}
console.log('  ✔ JourneyView 校验能拒绝 6 类非法响应');

// —— 8. 模型操作名是显式白名单 ——
assert.ok(contracts.MODEL_OP_NAMES.includes('opening'));
assert.ok(contracts.MODEL_OP_NAMES.includes('situation_recognition'));
assert.ok(!contracts.MODEL_OP_NAMES.includes('unknown_op'));
console.log(`  ✔ ${contracts.MODEL_OP_NAMES.length} 个显式模型操作名，未知名不在白名单`);

// —— 9. 指纹：同键同载荷稳定，载荷不同则不同 ——
const v1 = contracts.parseReleaseCommand({ species: 'koi', water: 'xihu', feeling: 'a', requestId: 'req-00000002' }).value;
const v2 = contracts.parseReleaseCommand({ water: 'xihu', feeling: 'a', species: 'koi', requestId: 'req-00000003' }).value;
const v3 = contracts.parseReleaseCommand({ species: 'koi', water: 'xihu', feeling: 'b', requestId: 'req-00000004' }).value;
assert.strictEqual(contracts.fingerprintOf('release', v1), contracts.fingerprintOf('release', v2),
  '字段顺序不同但内容相同 → 同一指纹');
assert.notStrictEqual(contracts.fingerprintOf('release', v1), contracts.fingerprintOf('release', v3),
  '内容不同 → 不同指纹');
console.log('  ✔ 幂等指纹与字段顺序无关、与内容相关');

// —— 10. 原生模块 ABI 与当前 Node 匹配 ——
// better-sqlite3 是原生模块：编译时的 Node ABI 必须与运行时的 Node 一致。
// 不一致时 require 直接抛 ERR_DLOPEN_FAILED，服务起不来、测试全红。
// 这个坑最费时间（错误信息指向模块内部，不像 Node 版本问题），
// 所以在这里提前断言，并给出可执行的修复命令。
console.log('  ── 原生模块 ABI ──');
{
  let abiOk = true;
  let detail = '';
  try {
    const Database = require('better-sqlite3');
    const db = new Database(':memory:');
    db.prepare('SELECT 1 AS x').get();
    db.close();
  } catch (e) {
    abiOk = false;
    const m = /NODE_MODULE_VERSION (\d+)[\s\S]*?requires[\s\S]*?NODE_MODULE_VERSION (\d+)/.exec(e.message);
    detail = m
      ? `模块按 ABI ${m[1]} 编译，当前 Node 是 ABI ${m[2]}。修复：npm rebuild better-sqlite3`
      : `加载失败：${e.message.split('\n')[0]}`;
  }
  if (!abiOk) {
    console.error(`  ✖ better-sqlite3 与当前 Node (${process.version}) ABI 不匹配`);
    console.error(`      ${detail}`);
    console.error('      这个错误会表现为 ERR_DLOPEN_FAILED，服务无法启动、所有测试失败。');
    process.exit(1);
  }
  console.log(`  ✔ better-sqlite3 可加载（Node ${process.version}）`);
}

console.log('\n契约检查通过。');
