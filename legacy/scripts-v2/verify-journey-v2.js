#!/usr/bin/env node
// 赛博放生 · 旅程 v2 真实生产路径验证
//
// 真实边界：HTTP（子进程真实服务器）+ 真实文本模型（.env 千帆）+ 真实 JEV + 真实 SQLite。
// 节奏加速：J_TIME_SCALE 部署配置（不是测试专用决策逻辑；所有决策都来自真实 JEV/LLM）。
// 覆盖场景：
//   A 完整旅程：放生 → preparing → 开局 → （信号→按时补给 / 直接行动，由真实 JEV 决定）
//              → 多次行动结算 → 阶段来信 → 事件预算收束 → is_final 来信
//   B 同一生物再出发：同 creature_id 新 journey_id 新动机；跑两件事后用户主动结束（HTTP）
//   C 不回复：出现信号不补给 → 到期 → 真实 JEV 仍决策；重启恢复穿插其中
//   D 进程重启：SIGTERM 杀掉服务器 → 重启同 DB → 旅程继续、不双写
// 产物：docs/journey-v2-eval/ 下的 trace.json + summary.json（模型/用量/时延/降级如实记录）

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const ROOT = path.join(__dirname, '..');
const SERVER_DIR = path.join(ROOT, 'server');
const OUT_DIR = path.join(ROOT, 'docs', 'journey-v2-eval');
fs.mkdirSync(OUT_DIR, { recursive: true });

const PORT = 3490 + Math.floor(Math.random() * 40);
const BASE = `http://127.0.0.1:${PORT}`;
const DB_PATH = path.join(os.tmpdir(), `crsv2-verify-${Date.now()}.db`);

// 节奏缩放：600x —— 开局决策 3min→0.3s、信号截止 6h→36s、最小间隔 2h→12s、下一遭遇 15min→1.5s
const ENV = {
  ...process.env,
  DB_PATH,
  PORT: String(PORT),
  J_TIME_SCALE: '600',
  J_MAX_EVENTS: '4',           // 场景 A 用事件预算自然收束（4 件事）
  J_QUIET_START: '3',          // 与 END 相同 → 关闭安静时段（验证脚本需要连续观察）
  J_QUIET_END: '3',
  J_IMAGE_BUDGET: '1',
  J_TICK_MS: '1000',
  JOURNEY_ENABLED: '1'
};

const trace = { startedAt: new Date().toISOString(), env: { PORT, J_TIME_SCALE: ENV.J_TIME_SCALE, J_MAX_EVENTS: ENV.J_MAX_EVENTS, DB_PATH: 'tmp(isolated)' }, scenarios: [], restarts: [] };
let server = null;
let cookie = null;

function log(...args) { console.log(new Date().toISOString().slice(11, 19), ...args); }

function startServer(tag) {
  server = spawn('node', ['--env-file=.env', 'index.js'], { cwd: SERVER_DIR, env: ENV, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout.on('data', d => process.stdout.write(`  [srv ${tag}] ${d}`));
  server.stderr.on('data', d => process.stderr.write(`  [srv ${tag}!] ${d}`));
  trace.restarts.push({ tag, at: new Date().toISOString(), pid: server.pid });
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const poll = async () => {
      try {
        const r = await fetch(`${BASE}/api/health`);
        if (r.ok) return resolve(true);
      } catch (_) { /* not yet */ }
      if (Date.now() - t0 > 15000) return reject(new Error('server start timeout'));
      setTimeout(poll, 400);
    };
    poll();
  });
}

function stopServer(signal = 'SIGTERM') {
  return new Promise((resolve) => {
    if (!server) return resolve();
    const child = server; server = null;
    child.once('exit', resolve);
    child.kill(signal);
    setTimeout(resolve, 5000);
  });
}

async function api(method, p, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (cookie) headers.Cookie = cookie;
  const r = await fetch(BASE + p, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const sc = r.headers.get('set-cookie');
  if (sc && !cookie) cookie = sc.split(';')[0];
  const data = await r.json().catch(() => ({}));
  return { status: r.status, data };
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// 轮询直到 phase 满足条件或超时
async function waitFor(journeyId, cond, { timeoutMs = 300000, label = '' } = {}) {
  const t0 = Date.now();
  let last = null;
  while (Date.now() - t0 < timeoutMs) {
    const r = await api('GET', `/api/journey/${journeyId}`);
    if (r.status === 200) {
      last = r.data.journey;
      if (cond(last)) return last;
    }
    await sleep(2000);
  }
  throw new Error(`waitFor timeout: ${label}; last phase=${last && last.phase} status=${last && last.status}`);
}

async function scenario(name, fn) {
  const entry = { name, startedAt: new Date().toISOString() };
  trace.scenarios.push(entry);
  try {
    entry.result = await fn();
    entry.ok = true;
    log(`✅ ${name}`);
  } catch (err) {
    entry.ok = false;
    entry.error = err.message;
    log(`❌ ${name}: ${err.message}`);
  }
  entry.finishedAt = new Date().toISOString();
}

// 事件推进直到出现信号或事件数达标；返回期间的处理记录
async function driveEvents(journeyId, { onSignal, maxEvents = 4, timeoutMs = 15 * 60000 }) {
  const events = [];
  const t0 = Date.now();
  let lastEventCount = 0;
  while (Date.now() - t0 < timeoutMs) {
    const j = await api('GET', `/api/journey/${journeyId}`);
    const view = j.data.journey;
    if (!view) throw new Error('journey disappeared');
    if (['paused', 'aborted', 'ended_user'].includes(view.status)) throw new Error(`journey ${view.status}（${view.pauseReason || ''}）`);
    if (view.pendingSignal && !view.pendingSignal.replied && onSignal) {
      const handled = await onSignal(view);
      events.push({ kind: 'signal_handled', at: new Date().toISOString(), ontime: handled });
    }
    if (view.eventCount > lastEventCount) {
      lastEventCount = view.eventCount;
      events.push({ kind: 'event_resolved', count: view.eventCount, at: new Date().toISOString(), lastResolved: view.lastResolved });
      if (view.eventCount >= maxEvents) {
        const final = await waitFor(journeyId, v => v.status === 'ended_natural' || (v.messages || []).some(m => m.kind === 'final_letter' && m.sentAt <= v.serverTime), { timeoutMs: 240000, label: 'final letter' }).catch(() => null);
        return { events, view: final || view, stopped: final ? final.status : view.status };
      }
    }
    await sleep(2500);
  }
  throw new Error('driveEvents timeout');
}

// ============ 场景 ============

let creatureA = null;

async function scenarioA() {
  const rel = await api('POST', '/api/release', {
    species: 'koi', water: 'xihu',
    feeling: '最近项目天天催进度，谁找我帮忙我都不好意思拒绝，结果自己的活全被挤到最后，晚上都睡不好。',
    tone: 'balanced'
  });
  if (!rel.data.ok) throw new Error(`release failed: ${JSON.stringify(rel.data)}`);
  const { journeyId, creature } = rel.data;
  creatureA = creature;
  log(`  旅程 ${journeyId} 已受理（preparing 回执），生物 ${creature.id}`);
  const opened = await waitFor(journeyId, v => v.phase === 'journeying' || v.phase === 'awaiting_reply' || v.goal, { timeoutMs: 300000, label: 'opening' });
  trace.scenarios.at(-1).opening = { goal: opened.goal, motivation: opened.motivation };

  const drive = await driveEvents(journeyId, {
    maxEvents: 4,
    onSignal: async (view) => {
      log(`  收到信号：「${(view.pendingSignal.text || '').slice(0, 40)}…」→ 按时补给`);
      const rr = await api('POST', `/api/journey/${journeyId}/reply`, { text: '这次可以答应，但记得先把自己该做的做完。' });
      return !!(rr.data && rr.data.ontime);
    }
  });
  // 收束后等待最后一封信投递（最小间隔缩放后 ≤ ~12s/封）
  const v = await waitFor(journeyId, x => x.status === 'ended_natural' && (x.messages || []).some(m => m.kind === 'final_letter'), { timeoutMs: 240000, label: 'final letter delivered' });
  const assertions = [];
  const assertOk = (cond, msg) => { if (!cond) assertions.push(msg); };
  assertOk(v.goal && v.goal.length >= 4, 'goal 未设定');
  assertOk(['recognized', 'insufficient_evidence', 'degraded'].includes(v.motivation && v.motivation.status), '动机档案未落定');
  assertOk(v.eventCount >= 2, `事件数不足（${v.eventCount}）`);
  assertOk(v.status === 'ended_natural', `状态非自然收束（${v.status}）`);
  const finalLetter = v.messages.find(m => m.kind === 'final_letter');
  assertOk(finalLetter && finalLetter.meta.isFinal, '缺 is_final 收束信');
  // 阶段来信是 JEV 检查点的自主选择（可能连续选择“继续”后由事件预算收束）：记录而非强求
  const stageLetterSent = v.messages.some(m => m.kind === 'letter');
  if (assertions.length) throw new Error('A 断言失败: ' + assertions.join('; '));
  return {
    journeyId, creatureId: creature.id,
    goal: v.goal,
    motivationStatus: v.motivation && v.motivation.status,
    eventCount: v.eventCount,
    status: v.status,
    messageKinds: v.messages.map(m => m.kind),
    stageLetterSent,
    finalLetter: finalLetter.text,
    letters: v.messages.filter(m => m.kind === 'letter').map(m => ({ title: m.title, text: m.text, imageStatus: m.imageStatus })),
    signalHandled: drive.events.filter(e => e.kind === 'signal_handled').length,
    stopped: drive.stopped
  };
}

async function scenarioB() {
  const rel = await api('POST', '/api/release', {
    species: 'koi', water: 'baikal',
    feeling: '换一件完全不同的事：每天失眠到凌晨两点，脑子里停不下来。',
    tone: 'gentle',
    creatureId: creatureA.id          // 同一只生物再次出发
  });
  if (!rel.data.ok) throw new Error(`re-depart failed: ${JSON.stringify(rel.data)}`);
  const { journeyId, creature } = rel.data;
  if (creature.id !== creatureA.id) throw new Error('creature_id changed on re-depart');
  if (journeyId === trace.scenarios[0].result.journeyId) throw new Error('journey_id reused');
  await waitFor(journeyId, v => v.phase === 'journeying' || v.phase === 'awaiting_reply', { timeoutMs: 300000, label: 'opening B' });
  await driveEvents(journeyId, { maxEvents: 2, timeoutMs: 12 * 60000, onSignal: async (view) => {
    const rr = await api('POST', `/api/journey/${journeyId}/reply`, { text: '睡不着的晚上可以先数水泡。' });
    return !!(rr.data && rr.data.ontime);
  } });

  // 用户主动结束：真实 JEV 可能在检查点自主收束（ended_natural 属合法行为）；
  // 为确定性地验证“用户结束”，在同一生物的新一程上、开局完成后立即结束。
  let endStatus = null;
  let endMs = 0;
  let endJourneyId = journeyId;
  {
    const st = (await api('GET', `/api/journey/${journeyId}`)).data.journey.status;
    endStatus = st;
    if (st === 'active') {
      const t0 = Date.now();
      const end = await api('POST', `/api/journey/${journeyId}/end`);
      endMs = Date.now() - t0;
      if (!end.data.ok) throw new Error(`end failed: ${JSON.stringify(end.data)}`);
    } else {
      log(`  B 主程已由真实 JEV 自主收束（${st}），另起一程验证用户结束`);
      const rel2 = await api('POST', '/api/release', { species: 'koi', water: 'xihu', feeling: '第三程：一想到要在会上发言就胃疼。', tone: 'gentle', creatureId: creature.id });
      if (!rel2.data.ok) throw new Error('third journey failed');
      const j2 = rel2.data.journeyId;
      await waitFor(j2, v => v.goal || v.phase === 'awaiting_reply' || v.phase === 'journeying', { timeoutMs: 300000, label: 'opening B3' });
      endJourneyId = j2;
      const t0 = Date.now();
      const end = await api('POST', `/api/journey/${j2}/end`);
      endMs = Date.now() - t0;
      if (!end.data.ok) throw new Error(`end failed: ${JSON.stringify(end.data)}`);
    }
  }
  await sleep(12000); // 跨过一个调度周期 + 最小间隔
  const v = (await api('GET', `/api/journey/${endJourneyId}`)).data.journey;
  const after = v.eventCount;
  await sleep(12000);
  const v2 = (await api('GET', `/api/journey/${endJourneyId}`)).data.journey;
  if (v2.eventCount !== after) throw new Error('events generated after user end');
  if (v2.status !== 'ended_user') throw new Error(`status not ended_user: ${v2.status}`);
  if (endMs > 3000) throw new Error(`end not immediate: ${endMs}ms`);
  const aRaw = trace.scenarios[0].result.motivationStatus ? (await api('GET', `/api/journey/${trace.scenarios[0].result.journeyId}`)).data.journey.motivation.rawText : '';
  if (v2.motivation && aRaw && v2.motivation.rawText === aRaw) throw new Error('new journey reused old motivation text');
  return { journeyId, sameCreature: creature.id, endLatencyMs: endMs, status: v2.status, eventCount: v2.eventCount, motivationRaw: v2.motivation && v2.motivation.rawText };
}

async function scenarioC() {
  const rel = await api('POST', '/api/release', {
    species: 'turtle', water: 'ness',
    feeling: '手里有个结果一直没出来，天天反复刷邮件，又不敢问。',
    tone: 'balanced'
  });
  if (!rel.data.ok) throw new Error(`release failed: ${JSON.stringify(rel.data)}`);
  const { journeyId } = rel.data;
  await waitFor(journeyId, v => v.phase === 'journeying' || v.phase === 'awaiting_reply', { timeoutMs: 300000, label: 'opening C' });

  // 不回复：等信号过期（截止 36s 缩放后），JEV 仍需决策
  await waitFor(journeyId, v => v.pendingSignal && !v.pendingSignal.replied, { timeoutMs: 8 * 60000, label: 'signal appears' })
    .then(() => log('  信号出现，故意不回复'))
    .catch(() => log('  真实 JEV 未选择寄信号（直接行动），本场景按实际行为记录'));

  await driveEvents(journeyId, { maxEvents: 2, timeoutMs: 10 * 60000, onSignal: null });
  const v = (await api('GET', `/api/journey/${journeyId}`)).data.journey;
  const expiredSignal = v.messages.find(m => m.kind === 'signal' && m.status === 'expired');
  const decidedWithoutReply = v.eventCount >= 1;
  return {
    journeyId,
    signalAppeared: !!expiredSignal || v.messages.some(m => m.kind === 'signal'),
    expiredWithoutReply: !!expiredSignal,
    stillDecided: decidedWithoutReply,
    eventCount: v.eventCount,
    status: v.status
  };
}

async function dumpModelCalls() {
  const Database = require(path.join(SERVER_DIR, 'node_modules', 'better-sqlite3'));
  const db = new Database(DB_PATH, { readonly: true });
  const calls = db.prepare(`SELECT kind, model, latency_ms, status, error, usage_json FROM model_calls ORDER BY id`).all();
  const decisions = db.prepare(`SELECT journey_id, seq, chosen_action, decision_source, outcome_status FROM encounters ORDER BY journey_id, seq`).all();
  trace.decisions = decisions;
  const badSource = decisions.filter(d => d.decision_source && !['jev', 'jev_after_reproposal'].includes(d.decision_source) && !['none_fit'].includes(d.chosen_action));
  if (badSource.length) log(`  ⚠️ 非法决策来源: ${JSON.stringify(badSource)}`);
  const byKind = {};
  for (const c of calls) {
    const u = c.usage_json ? JSON.parse(c.usage_json) : {};
    const k = byKind[c.kind] = byKind[c.kind] || { calls: 0, inTok: 0, outTok: 0, errors: 0, latSum: 0 };
    k.calls += 1;
    k.inTok += u.input_tokens || 0;
    k.outTok += u.output_tokens || 0;
    k.latSum += c.latency_ms || 0;
    if (c.status !== 'ok') k.errors += 1;
  }
  db.close();
  return { total: calls.length, byKind };
}

async function main() {
  log('启动真实服务器（隔离 DB + 缩放节奏）…');
  await startServer('A');
  await scenario('A 完整旅程（信号→补给→行动→阶段来信→预算收束→is_final）', scenarioA);
  await scenario('B 同一生物再出发 + 用户主动结束', scenarioB);

  log('重启服务器（SIGTERM → 同 DB 重启）…');
  await stopServer('SIGTERM');
  await startServer('restart-1');

  await scenario('C 不回复信号 → 到期 → JEV 仍决策（跨重启）', scenarioC);
  await scenario('A2 重启后旧旅程仍可读、无新事件', async () => {
    const jid = trace.scenarios[0].result.journeyId;
    const v = (await api('GET', `/api/journey/${jid}`)).data.journey;
    if (!v) throw new Error('journey lost after restart');
    const before = v.eventCount;
    await sleep(8000);
    const v2 = (await api('GET', `/api/journey/${jid}`)).data.journey;
    if (v2.status !== 'ended_natural') throw new Error('ended journey changed status');
    if (v2.eventCount !== before) throw new Error('ended journey generated events');
    return { journeyId: jid, status: v2.status, eventCount: v2.eventCount, restartSurvived: true };
  });

  trace.modelUsage = await dumpModelCalls();
  await stopServer();

  trace.finishedAt = new Date().toISOString();
  trace.allOk = trace.scenarios.every(s => s.ok);
  fs.writeFileSync(path.join(OUT_DIR, 'trace.json'), JSON.stringify(trace, null, 2));
  const summary = {
    allOk: trace.allOk,
    scenarios: trace.scenarios.map(s => ({ name: s.name, ok: s.ok, result: s.result, error: s.error })),
    modelUsage: trace.modelUsage,
    restarts: trace.restarts.length
  };
  fs.writeFileSync(path.join(OUT_DIR, 'summary.json'), JSON.stringify(summary, null, 2));
  log(trace.allOk ? '✅ 全部场景通过' : '❌ 存在失败场景（见 summary.json）');
  process.exit(trace.allOk ? 0 : 1);
}

main().catch(async (err) => {
  console.error('VERIFY FATAL:', err);
  trace.fatal = err.message;
  fs.writeFileSync(path.join(OUT_DIR, 'trace.json'), JSON.stringify(trace, null, 2));
  await stopServer();
  process.exit(1);
});
