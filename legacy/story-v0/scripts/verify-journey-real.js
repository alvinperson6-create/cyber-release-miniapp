// 旅程真实链路验证（会真实计费：JEV 动作判断若干次 + 1 条带账本的最终回信）
// 用法：cd server && node --env-file=.env ../scripts/verify-journey-real.js
// 产出：docs/jev-eval/journey-trace.json —— 输入→事件→动作→后果→留言→回信的完整追踪
// 对照：有留言 vs 无留言两条旅程（动作判定走真实 JEV；最终回信只为有留言路径生成 1 条）
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const PORT = 3196;
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'docs', 'jev-eval', 'journey-trace.json');
const DB = path.join(ROOT, 'docs', 'jev-eval', 'journey-trace.db');
for (const f of [DB, DB + '-wal', DB + '-shm']) if (fs.existsSync(f)) fs.unlinkSync(f);

const server = spawn(process.execPath, ['index.js'], {
  cwd: path.join(ROOT, 'server'),
  env: { ...process.env, PORT: String(PORT), DB_PATH: DB, JOURNEY_ENABLED: '1', JOURNEY_TIME_SCALE: '0.0002', IMAGE_API_KEY: '', IMAGE_BASE_URL: '', IMAGE_MODEL: '' },
  stdio: ['ignore', 'pipe', 'pipe']
});
let log = '';
server.stdout.on('data', d => { log += d; });
server.stderr.on('data', d => { log += d; });

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function waitForHealth() {
  const t0 = Date.now();
  while (Date.now() - t0 < 20000) {
    try { const r = await fetch(`${BASE}/api/health`); if (r.ok) return r.json(); } catch (e) {}
    await sleep(300);
  }
  throw new Error('服务未就绪');
}
async function release(openid, feeling) {
  const r = await fetch(`${BASE}/api/release`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ openid, creature: 'koi', water: 'xihu', feeling, feedbackTime: '24h' })
  });
  return r.json();
}
async function getJourney(id) {
  return (await (await fetch(`${BASE}/api/journey/${id}`)).json()).journey;
}

(async () => {
  const trace = { startedAt: new Date().toISOString(), input: '谁找我帮忙我都答应，最后只有我的事情没做完', paths: {} };
  try {
    const health = await waitForHealth();
    trace.health = { aiEnabled: health.aiEnabled, journeyEnabled: health.journeyEnabled };
    console.log('[journey-trace] 服务就绪', trace.health);

    // 两条同输入旅程：A 有留言，B 无留言（相同初始状态）
    const a = await release('trace-user-a', trace.input);
    const b = await release('trace-user-b', trace.input);
    const msg = await (await fetch(`${BASE}/api/journey/${a.id}/message`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: '这次你可以拒绝。' })
    })).json();
    trace.paths.withMessage = { recordId: a.id, message: { sent: msg.ok, intent: msg.intent, effect: msg.effect } };
    trace.paths.withoutMessage = { recordId: b.id, message: { sent: false } };
    console.log('[journey-trace] 留言:', msg.ok, msg.intent, msg.effect);

    // 等调度器推进（事件 ~4.3s 一个，等 30s 后再惰性拉一次兜底）
    await sleep(30000);
    const ja = await getJourney(a.id);
    const jb = await getJourney(b.id);
    trace.paths.withMessage.events = ja.events;
    trace.paths.withoutMessage.events = jb.events;
    console.log('[journey-trace] A(有留言) 动作序列:', ja.events.map(e => e.action).join('→'), '来源:', ja.events.map(e => e.actionSource).join(','));
    console.log('[journey-trace] B(无留言) 动作序列:', jb.events.map(e => e.action).join('→'), '来源:', jb.events.map(e => e.actionSource).join(','));

    // 有留言路径：生成带账本的最终回信（恰好 1 条故事生成）
    const gen = await (await fetch(`${BASE}/api/reply/generate`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: a.id })
    })).json();
    trace.paths.withMessage.finalReply = {
      semanticStatus: gen.semanticStatus,
      text: gen.reply?.text || null,
      wallMs: gen.wallMs || null
    };
    const jAfter = await getJourney(a.id);
    trace.paths.withMessage.frozenAfterReply = jAfter.terminalStatus;

    // 冻结后留言必须被拒
    const late = await (await fetch(`${BASE}/api/journey/${a.id}/message`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: '晚了' })
    })).json();
    trace.paths.withMessage.lateMessageRejected = late.ok === false && late.code === 'journey_ended';

    trace.finishedAt = new Date().toISOString();
    fs.writeFileSync(OUT, JSON.stringify(trace, null, 2));
    console.log('[journey-trace] 追踪已写入', OUT);
    console.log('[journey-trace] A 状态:', gen.semanticStatus, '回信预览:', (gen.reply?.text || '').slice(0, 80));
    console.log('[journey-trace] 冻结后留言被拒:', trace.paths.withMessage.lateMessageRejected);
  } finally {
    server.kill('SIGTERM');
  }
})().catch(err => { console.error('[journey-trace] 失败:', err); server.kill('SIGTERM'); process.exit(1); });
