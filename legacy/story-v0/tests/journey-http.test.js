// HTTP 集成测试（离线）：旅程实验双路径对照 —— 有留言 vs 无留言
// 真实服务进程 + 真实调度器推进（JEV 关闭 → 动作由确定性规则回退，对照的是"留言确实改变了
// 允许的行为倾向与后续事件"这一工程事实；模型侧判断效果由真实链路验证单独覆盖）
const { test } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const PORT = 3197;
const BASE = `http://127.0.0.1:${PORT}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cyber-release-jrn-http-'));
const DB = path.join(tmp, 'journey-http.db');

let server;

async function waitForHealth(timeoutMs = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.ok) return await r.json();
    } catch (e) {}
    await new Promise(r => setTimeout(r, 300));
  }
  throw new Error('服务未就绪');
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

test.before(async () => {
  server = spawn(process.execPath, ['index.js'], {
    cwd: path.join(__dirname, '..', 'server'),
    env: {
      ...process.env,
      PORT: String(PORT),
      DB_PATH: DB,
      AI_API_KEY: '', JEV_API_KEY: '',       // 离线：规则回退
      IMAGE_API_KEY: '', IMAGE_BASE_URL: '', IMAGE_MODEL: '',
      JOURNEY_ENABLED: '1',
      JOURNEY_TIME_SCALE: '0.0002'           // 24h 等待的可用窗口压缩到 ~4.3s/事件（部署配置）
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  server.stdout.on('data', () => {});
  server.stderr.on('data', () => {});
  const h = await waitForHealth();
  assert.equal(h.journeyEnabled, true);
});

test.after(() => { if (server) server.kill('SIGTERM'); });

async function release(openid, feeling) {
  const r = await fetch(`${BASE}/api/release`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ openid, creature: 'koi', water: 'xihu', feeling, feedbackTime: '24h' })
  });
  return r.json();
}

test('双路径：留言 → 事件选择改变；无留言 → 保持答应', async () => {
  const feeling = '谁找我帮忙我都答应，最后只有我的事情没做完';
  const a = await release('jrn-user-a', feeling); // 有留言
  const b = await release('jrn-user-b', feeling); // 无留言
  assert.ok(a.journey?.enabled, 'release 应返回旅程信息');
  assert.ok(b.journey?.enabled);

  // 立即给 A 留言（赶在调度器第一次推进之前）
  const msg = await fetch(`${BASE}/api/journey/${a.id}/message`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: '这次你可以拒绝。' })
  });
  const msgBody = await msg.json();
  assert.equal(msgBody.ok, true, JSON.stringify(msgBody));
  assert.equal(msgBody.intent, 'permission_to_refuse');
  assert.equal(msgBody.effect, 'tendency->assertive');

  // 等待调度器推进全部三个事件（时间轴 ~3.6s/事件，tick 10s，等 35s 足够）
  await sleep(35000);
  const ja = (await (await fetch(`${BASE}/api/journey/${a.id}`)).json()).journey;
  const jb = (await (await fetch(`${BASE}/api/journey/${b.id}`)).json()).journey;
  assert.equal(ja.events.length, 3);
  assert.equal(jb.events.length, 3);
  assert.ok(ja.events.every(e => e.action === '拒绝'), '有留言路径应全部拒绝：' + JSON.stringify(ja.events.map(e => e.action)));
  assert.ok(jb.events.every(e => e.action === '答应'), '无留言路径应全部答应：' + JSON.stringify(jb.events.map(e => e.action)));
  assert.equal(ja.message.text, '这次你可以拒绝。');
  assert.equal(jb.message, null);
});

test('旅程冻结：回信写入后旅程定格、留言被拒', async () => {
  const rec = await release('jrn-user-c', '谁找我帮忙我都答应，最后只有我的事情没做完');
  const gen = await (await fetch(`${BASE}/api/reply/generate`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: rec.id })
  })).json();
  assert.equal(gen.ok, true);
  await sleep(500); // 让调度器或惰性推进冻结
  const j = (await (await fetch(`${BASE}/api/journey/${rec.id}`)).json()).journey;
  assert.equal(j.terminalStatus, 'letter_frozen');
  const msg = await (await fetch(`${BASE}/api/journey/${rec.id}/message`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: '晚了' })
  })).json();
  assert.equal(msg.ok, false);
  assert.equal(msg.code, 'journey_ended');
});

test('开关关闭的旧记录不受影响：destiny 解锁语义照旧', async () => {
  const rel = await release('jrn-user-d', '测试旧功能兼容');
  const dst = await (await fetch(`${BASE}/api/destiny/${rel.id}`)).json();
  if (dst.totalSegments) {
    assert.equal(dst.segments[0].locked, false);
  }
});
