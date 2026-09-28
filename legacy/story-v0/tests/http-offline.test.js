// HTTP 集成测试（离线）：拉起真实服务进程（无 AI Key → 模板兜底路径），
// 验证真实 HTTP 编排、幂等、冻结与解锁语义。不调用任何外部模型。
const { test } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const PORT = 3199;
const BASE = `http://127.0.0.1:${PORT}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cyber-release-http-'));
const DB = path.join(tmp, 'http-test.db');

let server;
let serverLog = '';

async function waitForHealth(timeoutMs = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.ok) return await r.json();
    } catch (e) { /* not yet */ }
    await new Promise(r => setTimeout(r, 300));
  }
  throw new Error(`服务未在 ${timeoutMs}ms 内就绪\n${serverLog}`);
}

test.before(async () => {
  server = spawn(process.execPath, ['index.js'], {
    cwd: path.join(__dirname, '..', 'server'),
    env: {
      ...process.env,
      PORT: String(PORT),
      DB_PATH: DB,
      AI_API_KEY: '',           // 离线：无文本模型 → 模板兜底
      JEV_API_KEY: '',
      JOURNEY_ENABLED: '0',
      IMAGE_API_KEY: '',
      IMAGE_BASE_URL: '',
      IMAGE_MODEL: ''
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  server.stdout.on('data', d => { serverLog += d; });
  server.stderr.on('data', d => { serverLog += d; });
  await waitForHealth();
});

test.after(() => {
  if (server) server.kill('SIGTERM');
});

test('健康检查：AI 未启用', async () => {
  const h = await (await fetch(`${BASE}/api/health`)).json();
  assert.equal(h.aiEnabled, false);
});

test('放生 → 生成 → 回信为模板兜底、destiny 四集、状态可观测', async () => {
  const rel = await (await fetch(`${BASE}/api/release`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ openid: 'http-test-user', creature: 'koi', water: 'xihu', feeling: '每天都干不完，我真的想歇一下', feedbackTime: '24h' })
  })).json();
  assert.ok(rel.id, JSON.stringify(rel));

  const gen = await (await fetch(`${BASE}/api/reply/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: rel.id })
  })).json();
  assert.equal(gen.ok, true);
  assert.ok(gen.reply.text.length > 0);
  assert.equal(gen.semanticStatus, 'template_fallback');
  assert.equal(gen.destinyId, `DST-${rel.id}`);

  // 幂等：再生成一次，回信文本不变
  const gen2 = await (await fetch(`${BASE}/api/reply/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: rel.id })
  })).json();
  assert.equal(gen2.reply.text, gen.reply.text);

  // destiny：四集可查，第一段免费，其余锁定
  const dst = await (await fetch(`${BASE}/api/destiny/${rel.id}`)).json();
  assert.equal(dst.totalSegments, 4);
  assert.equal(dst.segments[0].locked, false);
  assert.equal(dst.segments[1].locked, true);
});

test('记录查询：状态 replied', async () => {
  const rel = await (await fetch(`${BASE}/api/release`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ openid: 'http-test-user', creature: 'turtle', water: 'baikal', feeling: '刚分手，心里空落落的', feedbackTime: '24h' })
  })).json();
  await fetch(`${BASE}/api/reply/generate`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: rel.id })
  });
  const rec = await (await fetch(`${BASE}/api/records/${rel.id}`)).json();
  assert.equal(rec.status, 'replied');
  assert.ok(rec.reply.text.length > 0);
});

test('世界脉搏照常工作（旧功能不回归）', async () => {
  const w = await (await fetch(`${BASE}/api/world/pulse`)).json();
  assert.ok(w.total >= 2);
  assert.ok(Array.isArray(w.recent));
});
