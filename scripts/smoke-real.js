#!/usr/bin/env node
// 赛博放生 · 真实生产路径冒烟
//
// 与 npm run check 的区别：这里用**真实**凭据、真实文本模型、真实 JEV，
// 会产生实际费用与用量，且不覆盖全部竞态分支。竞态与稀有分支的主要回归手段
// 仍是固定场景（npm run check）。
//
// 用法：
//   node scripts/smoke-real.js                 # 默认用隔离库，跑一遍主链
//   node scripts/smoke-real.js --keep-db       # 保留隔离库路径便于复查
//
// 明确边界：
// - 一定使用**隔离数据库**，绝不碰 server/data.db
// - 凭据缺失时如实报告"未验证"，不伪造成功，不无限等待
// - 真实模型没走到的分支如实标"未覆盖"

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const ROOT = path.join(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'docs', 'agent-environment-validation-artifacts');
const KEEP_DB = process.argv.includes('--keep-db');

const PORT = 3490 + Math.floor(Math.random() * 60);
const BASE = `http://127.0.0.1:${PORT}`;
const DB_PATH = path.join(os.tmpdir(), `cyber-release-smoke-${Date.now()}.db`);

// 节奏缩放只是部署配置（不是测试专用决策逻辑）：所有决策仍来自真实 JEV / LLM
const ENV = {
  ...process.env,
  DB_PATH,
  PORT: String(PORT),
  J_TIME_SCALE: '900',
  J_MAX_EVENTS: '3',
  JOURNEY_ENABLED: '1'
};

const trace = {
  startedAt: new Date().toISOString(),
  runMode: 'real-production-path',
  isolatedDb: DB_PATH,
  steps: [],
  covered: [],
  notCovered: [],
  errors: []
};

function note(step, detail) {
  trace.steps.push({ step, at: new Date().toISOString(), ...detail });
  console.log(`  · ${step}${detail ? ' — ' + JSON.stringify(detail).slice(0, 160) : ''}`);
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function startServer() {
  const child = spawn(process.execPath, ['--env-file-if-exists=server/.env', 'serving/entrypoints/start.js'], {
    cwd: ROOT, env: ENV, stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stdout.on('data', d => process.stdout.write(`  [srv] ${d}`));
  child.stderr.on('data', d => process.stderr.write(`  [srv!] ${d}`));
  return child;
}

async function waitHealthy(timeoutMs = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.ok) return await r.json();
    } catch (_) { /* 还没起来 */ }
    await sleep(400);
  }
  return null;
}

/** 带 cookie 的会话 */
async function session() {
  const r = await fetch(`${BASE}/api/release`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ species: 'koi', water: 'xihu', feeling: '明天要答辩，紧张到胃疼', tone: 'balanced' })
  });
  const cookie = (r.headers.get('set-cookie') || '').split(';')[0];
  const body = await r.json();
  return { cookie, journeyId: body.journeyId, first: body };
}

async function readJourney(cookie, id) {
  const r = await fetch(`${BASE}/api/journey/${id}`, { headers: { Cookie: cookie } });
  return { status: r.status, body: await r.json() };
}

/** 推进到某个阶段或超时 */
async function waitForPhase(cookie, id, phases, maxMs = 120000) {
  const t0 = Date.now();
  let last = null;
  while (Date.now() - t0 < maxMs) {
    const { body } = await readJourney(cookie, id);
    last = body.journey;
    if (last && phases.includes(last.phase)) return last;
    await sleep(1500);
  }
  return last;
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const envPath = path.join(ROOT, 'server', '.env');
  const hasTextModel = fs.existsSync(envPath) && /AI_API_KEY=\S/.test(fs.readFileSync(envPath, 'utf8'));
  const hasJev = fs.existsSync(envPath) && /JEV_API_KEY=\S/.test(fs.readFileSync(envPath, 'utf8'));
  if (!hasTextModel) {
    console.error('真实冒烟无法进行：未找到 AI_API_KEY（server/.env）');
    console.error('如实记录为"真实连通未验证"，不做任何伪造。');
    writeTrace('missing_credentials');
    return 2;
  }

  console.log('赛博放生 · 真实生产路径冒烟');
  console.log(`  隔离库：${DB_PATH}`);
  console.log(`  文本模型凭据：${hasTextModel ? '有' : '无'}｜JEV 凭据：${hasJev ? '有' : '无'}\n`);
  if (!hasJev) {
    trace.notCovered.push('JEV 决策（无凭据）：旅程会如实暂停，不会用规则冒充');
  }

  const server = startServer();
  let exitCode = 0;

  try {
    const health = await waitHealthy();
    if (!health) {
      console.error('服务未在 20s 内就绪');
      trace.errors.push('server_not_ready');
      writeTrace('failed');
      return 1;
    }
    note('health', { contractVersion: health.contractVersion, aiEnabled: health.aiEnabled, jevEnabled: health.jevEnabled });

    // 1. 建程：命令立即返回 preparing
    const s = await session();
    if (!s.journeyId) {
      console.error('建程失败：' + JSON.stringify(s.first));
      trace.errors.push('release_failed');
      writeTrace('failed');
      return 1;
    }
    note('release', { journeyId: s.journeyId, status: s.first.status });

    // 2. 开局：后台编排产出目标
    const opening = await waitForPhase(s.cookie, s.journeyId, ['journeying', 'awaiting_reply', 'experiencing'], 90000);
    note('opening', opening ? { phase: opening.phase, goal: Boolean(opening.goal) } : { phase: null });
    if (!opening || !opening.goal) {
      trace.notCovered.push('开局（真实模型未在时限内产出目标）');
    } else {
      trace.covered.push('opening');
    }

    // 3. 推进到结束或收束
    const ended = await waitForPhase(s.cookie, s.journeyId, ['ended', 'paused'], 180000);
    note('progress', ended ? { phase: ended.phase, status: ended.status, messages: ended.messages.length } : { phase: null });

    // 3b. 如实判定哪些路径真的走到了
    // 旅程因 JEV/模型不可用而暂停是**正确行为**（不规则冒充），
    // 但它意味着决策/结算/来信路径**没有被真实模型验证过**，必须记为未覆盖。
    if (ended && ended.status === 'paused') {
      trace.notCovered.push('决策/结算/来信（真实模型或 JEV 在验证窗口内不可用，旅程如实暂停）');
      trace.pauseReason = ended.pauseReason || null;
      const kinds = (ended.messages || []).map(m => m.kind);
      if (!kinds.includes('letter')) trace.notCovered.push('阶段来信（真实模型未走到该分支）');
      if (!kinds.includes('final_letter')) trace.notCovered.push('收束来信（真实模型未走到该分支）');
    } else if (ended && ended.phase === 'ended') {
      const kinds = (ended.messages || []).map(m => m.kind);
      if (kinds.includes('letter')) trace.covered.push('letter');
      if (kinds.includes('final_letter')) trace.covered.push('final_letter');
      if (kinds.includes('signal')) trace.covered.push('signal');
    }
    if (ended && (ended.messages || []).some(m => m.kind === 'signal')) trace.covered.push('signal');
    if (!trace.covered.includes('settlement')) {
      trace.notCovered.push('结算（真实 JEV 决策未成功完成）');
    }

    // 4. 结束：用户主动结束立即生效
    const endRes = await fetch(`${BASE}/api/journey/${s.journeyId}/end`, { method: 'POST', headers: { Cookie: s.cookie } });
    const endBody = await endRes.json();
    note('end', { http: endRes.status, ok: endBody.ok });

    const final = await readJourney(s.cookie, s.journeyId);
    note('final', {
      status: final.body.journey?.status,
      messages: (final.body.journey?.messages || []).map(m => m.kind),
      timelineNodes: final.body.journey?.phase === 'ended' ? 'available' : 'n/a'
    });

    if (final.body.journey?.status === 'ended_user') trace.covered.push('user_end');
    else trace.notCovered.push('用户结束未在验证窗口内生效');

    // 5. 回顾时间线（结束后开放）
    const tl = await fetch(`${BASE}/api/journey/${s.journeyId}/timeline`, { headers: { Cookie: s.cookie } });
    const tlBody = await tl.json();
    note('timeline', { http: tl.status, nodes: tlBody.timeline?.nodes?.length ?? null });
    if (tl.status === 200) trace.covered.push('timeline');
    else trace.notCovered.push(`回顾时间线未开放（HTTP ${tl.status}）`);

  } catch (err) {
    console.error('冒烟异常：' + err.message);
    trace.errors.push(err.message);
    exitCode = 1;
  } finally {
    server.kill('SIGTERM');
    await sleep(600);
    server.kill('SIGKILL');
  }

  // 用量如实统计（成本未知就记未知）
  trace.modelCalls = readCalls(DB_PATH);
  writeTrace(exitCode === 0 ? 'ok' : 'failed');

  console.log(`\n真实调用次数：${trace.modelCalls.length}`);
  console.log(`  明细：${JSON.stringify(trace.modelCalls.reduce((acc, c) => {
    const k = `${c.kind}/${c.status}`;
    acc[k] = (acc[k] || 0) + 1;
    return acc;
  }, {}))}`);
  console.log(`覆盖：${trace.covered.join(', ') || '（无）'}`);
  console.log(`未覆盖：${trace.notCovered.join('；') || '（无）'}`);
  if (trace.errors.length) console.log(`错误：${trace.errors.join(', ')}`);

  // 未覆盖不为空时退出码为 0 但明确标注：这不是"通过"，是"部分验证"
  if (trace.notCovered.length) {
    console.log('\n注意：存在未覆盖路径。上面的结果是"部分验证"，不是"全部通过"。');
    console.log('      未覆盖原因通常是外部服务不可用或真实模型没走到该分支；');
    console.log('      不要用 fixture 的结论替代它。');
  }

  if (!KEEP_DB) { try { fs.unlinkSync(DB_PATH); } catch (_) {} }
  else console.log(`隔离库保留在：${DB_PATH}`);

  console.log(`证据：${path.relative(ROOT, path.join(OUT_DIR, 'smoke-real.json'))}`);
  return exitCode;
}

function readCalls(dbPath) {
  if (!fs.existsSync(dbPath)) return [];
  try {
    const Database = require(path.join(ROOT, 'node_modules', 'better-sqlite3'));
    const db = new Database(dbPath, { readonly: true });
    const rows = db.prepare(
      `SELECT kind, provider, model, status, attempt FROM model_calls ORDER BY id`
    ).all();
    db.close();
    return rows;
  } catch (e) {
    return [{ note: 'read_failed', error: e.message }];
  }
}

function writeTrace(result) {
  trace.finishedAt = new Date().toISOString();
  trace.result = result;
  const file = path.join(OUT_DIR, 'smoke-real.json');
  fs.writeFileSync(file, JSON.stringify(trace, null, 2));
}

main().then(code => { process.exitCode = code; })
  .catch(err => { console.error(err); process.exitCode = 1; });
