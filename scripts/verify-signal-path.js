#!/usr/bin/env node
// 定向尝试：让真实 JEV 面对“高度未决”的处境（最可能寄信号的场景），并故意不回复，
// 观察真实信号 → 到期 → 无补给决策。结果如实写入 docs/journey-v2-eval/signal-attempt.json。
// （此前 3 次完整旅程中真实 JEV 均选择直接行动，未寄信号——本脚本单独验证该路径。）
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const ROOT = path.join(__dirname, '..');
const PORT = 3590 + Math.floor(Math.random() * 20);
const BASE = `http://127.0.0.1:${PORT}`;
const DB_PATH = path.join(os.tmpdir(), `crsv2-signal-${Date.now()}.db`);
const ENV = { ...process.env, DB_PATH, PORT: String(PORT), J_TIME_SCALE: '600', J_MAX_EVENTS: '3', J_QUIET_START: '3', J_QUIET_END: '3', J_IMAGE_BUDGET: '0', J_TICK_MS: '1000', JOURNEY_ENABLED: '1' };
let server = null, cookie = null;
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function api(method, p, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (cookie) headers.Cookie = cookie;
  const r = await fetch(BASE + p, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const sc = r.headers.get('set-cookie');
  if (sc && !cookie) cookie = sc.split(';')[0];
  return { status: r.status, data: await r.json().catch(() => ({})) };
}
async function main() {
  server = spawn('node', ['--env-file=.env', 'index.js'], { cwd: path.join(ROOT, 'server'), env: ENV, stdio: ['ignore', 'ignore', 'inherit'] });
  const t0 = Date.now();
  while (Date.now() - t0 < 15000) { try { const h = await fetch(`${BASE}/api/health`); if (h.ok) break; } catch (_) {} await sleep(400); }
  const out = { startedAt: new Date().toISOString(), signalAppeared: false, expired: false, decidedAfterExpiry: false, letters: [], events: 0, status: null };
  try {
    const rel = await api('POST', '/api/release', { species: 'turtle', water: 'mariana', feeling: '同事让我这周末帮他搬一整天家，可这是我唯一的休息日，我很想拒绝又怕伤了感情，到现在没敢回他消息。', tone: 'balanced' });
    const jid = rel.data.journeyId;
    log('旅程', jid, '已受理');
    const deadline = Date.now() + 9 * 60000;
    let sawSignal = false, waitedPastDue = false;
    while (Date.now() < deadline) {
      const v = (await api('GET', `/api/journey/${jid}`)).data.journey;
      if (!v) throw new Error('journey missing');
      if (v.pendingSignal && !sawSignal) {
        sawSignal = true; out.signalAppeared = true;
        out.signalText = v.pendingSignal.text;
        out.signalDueAt = v.pendingSignal.dueAt;
        log('📡 真实信号到达：「' + (v.pendingSignal.text || '').slice(0, 60) + '…」——故意不回复，等到期');
      }
      if (sawSignal && !waitedPastDue && Date.now() > out.signalDueAt + 3000) {
        waitedPastDue = true;
        log('⏰ 已过补给截止，等待 JEV 无补给决策');
      }
      if (sawSignal && waitedPastDue && v.eventCount >= 1) {
        const enc = v.pendingSignal; // 若还挂着说明没决策
        out.decidedAfterExpiry = !enc || enc.replied || v.phase !== 'awaiting_reply';
        break;
      }
      if (['ended_natural', 'paused', 'aborted'].includes(v.status)) break;
      await sleep(2500);
    }
    // 等旅程走完（最多再等 6 分钟）
    const dl2 = Date.now() + 6 * 60000;
    while (Date.now() < dl2) {
      const v = (await api('GET', `/api/journey/${jid}`)).data.journey;
      if (['ended_natural', 'paused', 'aborted'].includes(v.status)) { out.status = v.status; out.events = v.eventCount; break; }
      await sleep(3000);
    }
    const v = (await api('GET', `/api/journey/${jid}`)).data.journey;
    out.status = out.status || v.status;
    out.events = v.eventCount;
    out.letters = v.messages.filter(m => ['signal', 'letter', 'final_letter'].includes(m.kind)).map(m => ({ kind: m.kind, status: m.status, title: m.title, text: (m.text || '').slice(0, 240) }));
    const sig = out.letters.find(m => m.kind === 'signal');
    out.expired = !!(sig && sig.status === 'expired');
    log(out.signalAppeared ? (out.expired ? '✅ 真实信号 → 过期未复 → JEV 仍决策' : '信号出现但链路未完整走完') : '真实 JEV 仍选择直接行动（未寄信号）——如实记录');
  } finally {
    server.kill('SIGTERM');
  }
  out.finishedAt = new Date().toISOString();
  fs.mkdirSync(path.join(ROOT, 'docs', 'journey-v2-eval'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'docs', 'journey-v2-eval', 'signal-attempt.json'), JSON.stringify(out, null, 2));
  console.log(JSON.stringify({ signalAppeared: out.signalAppeared, expired: out.expired, decidedAfterExpiry: out.decidedAfterExpiry, events: out.events, status: out.status }));
}
main().catch(e => { console.error('FATAL', e); server && server.kill('SIGTERM'); process.exit(1); });
