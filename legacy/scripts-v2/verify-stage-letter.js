#!/usr/bin/env node
// 定向补验：调大 J_MAX_EVENTS 给真实 JEV 更多联系检查点机会，
// 观察它是否会自主选择寄出【非终局阶段经历来信】（handoff §5 验收链路的一环）。
// 不写任何测试专用决策逻辑：检查点选择完全来自真实 JEV。
// 结果如实写入 docs/journey-v2-eval/stage-letter-attempt.json。
//
// 用法：node scripts/verify-stage-letter.js [最大事件数=10] [观察分钟=30]

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const ROOT = path.join(__dirname, '..');
const MAX_EVENTS = parseInt(process.argv[2] || '10', 10);
const OBSERVE_MIN = parseInt(process.argv[3] || '30', 10);
const PORT = 3610 + Math.floor(Math.random() * 20);
const BASE = `http://127.0.0.1:${PORT}`;
const DB_PATH = path.join(os.tmpdir(), `crsv2-stage-${Date.now()}.db`);

const ENV = {
  ...process.env, DB_PATH, PORT: String(PORT),
  J_TIME_SCALE: '600',
  J_MAX_EVENTS: String(MAX_EVENTS),
  J_MAX_MODEL_CALLS: String(30 + MAX_EVENTS * 7),
  J_QUIET_START: '3', J_QUIET_END: '3',
  J_IMAGE_BUDGET: '0', J_TICK_MS: '1000',
  JOURNEY_ENABLED: '1'
};

let server = null, cookie = null;
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function startServer() {
  server = spawn('node', ['--env-file=.env', 'index.js'], { cwd: path.join(ROOT, 'server'), env: ENV, stdio: ['ignore', 'ignore', 'inherit'] });
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const poll = async () => {
      try { const r = await fetch(`${BASE}/api/health`); if (r.ok) return resolve(); } catch (_) {}
      if (Date.now() - t0 > 15000) return reject(new Error('server start timeout'));
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

async function main() {
  await startServer();
  const out = {
    startedAt: new Date().toISOString(), maxEvents: MAX_EVENTS,
    goal: null, stageLetterSeen: false, stageLetterText: null,
    finalLetterSeen: false, signalCount: 0, eventCount: 0, status: null,
    checkpoints: [], letterDeliveredLatencyMs: null
  };
  try {
    const rel = await api('POST', '/api/release', {
      species: 'cloud', water: 'aegean',
      feeling: '最近总觉得所有事都堆在一起压过来，白天帮所有人收尾，晚上一个人赶自己的活，越拖越多，睡也睡不踏实。',
      tone: 'balanced'
    });
    if (!rel.data.ok) throw new Error(`release failed: ${JSON.stringify(rel.data)}`);
    const jid = rel.data.journeyId;
    log('旅程', jid, `已受理（J_MAX_EVENTS=${MAX_EVENTS}）`);

    const deadline = Date.now() + OBSERVE_MIN * 60000;
    let lastEvent = 0;
    let letterAt = null;
    while (Date.now() < deadline) {
      const v = (await api('GET', `/api/journey/${jid}`)).data.journey;
      if (!v) throw new Error('journey missing');
      if (!out.goal && v.goal) { out.goal = v.goal; log('开局目标：「' + v.goal.slice(0, 40) + '…」'); }
      if (v.pendingSignal && !v.pendingSignal.replied) {
        out.signalCount++;
        log('📡 信号到达（第' + out.signalCount + '次）→ 按时补给');
        await api('POST', `/api/journey/${jid}/reply`, { text: '先把别人托的事收个尾，剩下的留给自己。' });
      }
      if (v.eventCount > lastEvent) {
        lastEvent = v.eventCount;
        log(`  事件 ${v.eventCount}/${MAX_EVENTS} 已结算`);
      }
      // 等待消息投递（最小间隔缩放后 ≤ ~12s）
      const now2 = (await api('GET', `/api/journey/${jid}`)).data.journey;
      const stage = (now2.messages || []).find(m => m.kind === 'letter' && m.sentAt <= now2.serverTime);
      if (stage && !out.stageLetterSeen) {
        out.stageLetterSeen = true;
        out.stageLetterText = stage.text;
        out.stageLetterTitle = stage.title;
        letterAt = Date.now();
        log('💌 真实 JEV 自主寄出非终局阶段来信《' + (stage.title || '') + '》');
      }
      if (out.stageLetterSeen && !out.finalLetterSeen) {
        const fin = (now2.messages || []).find(m => m.kind === 'final_letter' && m.sentAt <= now2.serverTime);
        if (fin) {
          out.finalLetterSeen = true;
          out.letterDeliveredLatencyMs = letterAt ? Date.now() - letterAt : null;
        }
      }
      if (['ended_natural', 'paused', 'aborted'].includes(v.status)) {
        out.status = v.status;
        out.eventCount = v.eventCount;
        break;
      }
      await sleep(2500);
    }
    // 收尾：再等最多 3 分钟让最后的信投递
    const dl2 = Date.now() + 3 * 60000;
    while (Date.now() < dl2) {
      const v = (await api('GET', `/api/journey/${jid}`)).data.journey;
      out.status = out.status && !['active'].includes(out.status) ? out.status : v.status;
      out.eventCount = v.eventCount;
      const stage = (v.messages || []).find(m => m.kind === 'letter' && m.sentAt <= v.serverTime);
      if (stage && !out.stageLetterSeen) { out.stageLetterSeen = true; out.stageLetterText = stage.text; out.stageLetterTitle = stage.title; }
      const fin = (v.messages || []).find(m => m.kind === 'final_letter' && m.sentAt <= v.serverTime);
      if (fin && !out.finalLetterSeen) { out.finalLetterSeen = true; break; }
      if (out.stageLetterSeen && !fin && ['ended_natural'].includes(v.status)) break;
      await sleep(3000);
    }
    // 从 DB 拉全量消息与调用 kind（只读）
    const Database = require(path.join(ROOT, 'server', 'node_modules', 'better-sqlite3'));
    const db = new Database(DB_PATH, { readonly: true });
    out.messages = db.prepare(`SELECT kind, status, title, substr(text,1,160) t FROM messages WHERE kind IN ('signal','letter','final_letter','system') ORDER BY sent_at`).all();
    const kinds = db.prepare(`SELECT kind, COUNT(*) c FROM model_calls GROUP BY kind`).all();
    out.modelCallKinds = kinds;
    out.hasRealLetterWrite = kinds.some(k => k.kind === 'letter_write' && k.c > 0);
    db.close();
    log(out.stageLetterSeen
      ? `✅ 真实 JEV 在第 ${out.eventCount} 事件前寄出了非终局阶段来信`
      : `❌ 观察窗口内真实 JEV 未寄出非终局阶段来信（事件 ${out.eventCount}，终态 ${out.status}）——如实记录`);
  } finally {
    await stopServer();
  }
  out.finishedAt = new Date().toISOString();
  fs.mkdirSync(path.join(ROOT, 'docs', 'journey-v2-eval'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'docs', 'journey-v2-eval', 'stage-letter-attempt.json'), JSON.stringify(out, null, 2));
  console.log(JSON.stringify({ stageLetterSeen: out.stageLetterSeen, finalLetterSeen: out.finalLetterSeen, events: out.eventCount, status: out.status, hasRealLetterWrite: out.hasRealLetterWrite }));
}

main().catch(async e => { console.error('FATAL', e); await stopServer(); process.exit(1); });
