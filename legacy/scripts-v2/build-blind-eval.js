#!/usr/bin/env node
// 盲评材料生成：同一处境多次出发，收集信号/来信/遭遇结算，
// 匿名化为 A/B/C 供人工盲评（换皮、因果自然度、好笑程度、被尊重感、继续阅读意愿）。
// 产物：docs/journey-v2-eval/blind-eval/（材料匿名；对应关系在 key.json，评完再对照）
//
// 用法：node scripts/build-blind-eval.js [份数=3]
// 注意：调用真实模型；每份约 2-3 个事件后人工结束，控制成本。

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const ROOT = path.join(__dirname, '..');
const SERVER_DIR = path.join(ROOT, 'server');
const OUT_DIR = path.join(ROOT, 'docs', 'journey-v2-eval', 'blind-eval');
fs.mkdirSync(OUT_DIR, { recursive: true });

const COPIES = parseInt(process.argv[2] || '3', 10);
const PORT = 3530 + Math.floor(Math.random() * 40);
const BASE = `http://127.0.0.1:${PORT}`;
const DB_PATH = path.join(os.tmpdir(), `crsv2-blind-${Date.now()}.db`);

const FEELING = '最近项目天天催进度，谁找我帮忙我都不好意思拒绝，结果自己的活全被挤到最后，晚上都睡不好。';
const WATERS = ['xihu', 'baikal', 'pacific'];
const TONES = ['balanced', 'balanced', 'gentle'];

const ENV = {
  ...process.env, DB_PATH, PORT: String(PORT),
  J_TIME_SCALE: '600', J_MAX_EVENTS: '3', J_MAX_MODEL_CALLS: '40',
  J_QUIET_START: '3', J_QUIET_END: '3', J_IMAGE_BUDGET: '0', J_TICK_MS: '1000',
  JOURNEY_ENABLED: '1'
};

let server = null, cookie = null;
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function startServer() {
  server = spawn('node', ['--env-file=.env', 'index.js'], { cwd: SERVER_DIR, env: ENV, stdio: ['ignore', 'inherit', 'inherit'] });
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const poll = async () => {
      try { const r = await fetch(`${BASE}/api/health`); if (r.ok) return resolve(); } catch (_) {}
      if (Date.now() - t0 > 15000) return reject(new Error('timeout'));
      setTimeout(poll, 400);
    };
    poll();
  });
}
function stopServer() {
  return new Promise(r => { if (!server) return r(); server.once('exit', r); server.kill('SIGTERM'); setTimeout(r, 5000); });
}
async function api(method, p, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (cookie) headers.Cookie = cookie;
  const r = await fetch(BASE + p, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const sc = r.headers.get('set-cookie');
  if (sc && !cookie) cookie = sc.split(';')[0];
  return { status: r.status, data: await r.json().catch(() => ({})) };
}
async function waitFor(jid, cond, timeoutMs = 240000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const v = (await api('GET', `/api/journey/${jid}`)).data.journey;
    if (v && cond(v)) return v;
    await sleep(2500);
  }
  throw new Error('waitFor timeout');
}

async function main() {
  await startServer();
  const materials = [];
  const key = [];
  try {
    for (let i = 0; i < COPIES; i++) {
      const label = String.fromCharCode(65 + i); // A/B/C
      log(`生成盲评材料 ${label}（同一处境，第 ${i + 1} 次出发）`);
      const rel = await api('POST', '/api/release', { species: ['koi', 'turtle', 'cloud'][i % 3], water: WATERS[i % 3], feeling: FEELING, tone: TONES[i % 3] });
      if (!rel.data.ok) throw new Error(`release failed ${JSON.stringify(rel.data)}`);
      const { journeyId } = rel.data;
      const t0 = Date.now();
      while (Date.now() - t0 < 10 * 60000) {
        const v = (await api('GET', `/api/journey/${journeyId}`)).data.journey;
        if (!v) throw new Error('journey missing');
        if (['ended_natural', 'paused', 'aborted'].includes(v.status)) break;
        if (v.pendingSignal && !v.pendingSignal.replied) {
          await api('POST', `/api/journey/${journeyId}/reply`, { text: '可以先把自己的事做完。' });
        }
        await sleep(2500);
      }
      let v = (await api('GET', `/api/journey/${journeyId}`)).data.journey;
      // 等最后投递（最小间隔缩放后 ≤12s）
      for (let k = 0; k < 6; k++) { await sleep(4000); v = (await api('GET', `/api/journey/${journeyId}`)).data.journey; if (!v.messages.some(m => m.sentAt > v.serverTime)) break; }
      materials.push({
        label,
        water: v.waterName,
        creature: v.creatureName,
        goal: v.goal,
        messages: v.messages.filter(m => ['signal', 'letter', 'final_letter'].includes(m.kind)).map(m => ({ kind: m.kind, title: m.title, text: m.text })),
        status: v.status,
        eventCount: v.eventCount
      });
      key.push({ label, journeyId, creatureId: v.creatureId, status: v.status });
      log(`  ${label} 完成（${v.eventCount} 事件，${v.status}）`);
    }
  } finally {
    await stopServer();
  }
  // 匿名材料（不含生物名/水域，避免评审被设定带偏？——保留生物与水域：它们是体验的一部分，但隐去旅程 ID）
  const anon = materials.map(m => ({ label: m.label, creature: m.creature, water: m.water, goal: m.goal, messages: m.messages, status: m.status, eventCount: m.eventCount }));
  fs.writeFileSync(path.join(OUT_DIR, 'materials.json'), JSON.stringify({ feeling: FEELING, copies: anon, generatedAt: new Date().toISOString(), humanReviewed: false }, null, 2));
  fs.writeFileSync(path.join(OUT_DIR, 'key.json'), JSON.stringify(key, null, 2));
  log(`✅ 盲评材料已写入 ${OUT_DIR}/materials.json（${anon.length} 份；key.json 请评完后才打开）`);
}

main().catch(async e => { console.error('FATAL', e); await stopServer(); process.exit(1); });
