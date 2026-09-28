// 真实生产路径验证（会真实计费：2 条故事生成 + 1 张图片，JEV 判断若干次）
// 用法：cd server && node --env-file=.env ../scripts/verify-real-path.js
// 验证内容：
//   1. 真实 HTTP 服务 + 真实 JEV（处境判断 + 因果验收）+ 真实文本模型 + 统一编排
//   2. 真实配图路径（用生产函数 generateReplyImage，恰好一张）
//   3. 幂等：重复 /generate 不改变已接受故事
// 输出：docs/jev-eval/real-path/ 下的证据 JSON
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const PORT = 3198;
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'docs', 'jev-eval', 'real-path');
fs.mkdirSync(OUT, { recursive: true });
const DB = path.join(OUT, 'real-verify.db');
if (fs.existsSync(DB)) fs.unlinkSync(DB);

const server = spawn(process.execPath, ['index.js'], {
  cwd: path.join(ROOT, 'server'),
  env: {
    ...process.env,
    PORT: String(PORT),
    DB_PATH: DB,
    IMAGE_API_KEY: '',   // 连通性阶段先关闭图片（成本控制），最后单独验证一张
    IMAGE_BASE_URL: '',
    IMAGE_MODEL: ''
  },
  stdio: ['ignore', 'pipe', 'pipe']
});
let log = '';
server.stdout.on('data', d => { log += d; process.stdout.write(d); });
server.stderr.on('data', d => { log += d; process.stderr.write(d); });

async function waitForHealth(timeoutMs = 20000) {
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

async function release(feeling, creature, water) {
  const r = await fetch(`${BASE}/api/release`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ openid: 'real-verify-user', creature, water, feeling, feedbackTime: '24h' })
  });
  return r.json();
}

async function generate(id) {
  const t0 = Date.now();
  const r = await fetch(`${BASE}/api/reply/generate`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id })
  });
  return { body: await r.json(), wallMs: Date.now() - t0 };
}

(async () => {
  const evidence = { startedAt: new Date().toISOString(), records: [] };
  try {
    const health = await waitForHealth();
    evidence.health = health;
    console.log('\n[verify] 服务就绪 aiEnabled=', health.aiEnabled);

    const cases = [
      { feeling: '每天都干不完，我真的想歇一下', creature: 'koi', water: 'xihu' },
      { feeling: '谁找我帮忙我都答应，最后只有我的事情没做完', creature: 'turtle', water: 'baikal' }
    ];

    for (const c of cases) {
      const rel = await release(c.feeling, c.creature, c.water);
      const { body, wallMs } = await generate(rel.id);
      const rec = {
        input: c,
        recordId: rel.id,
        ok: body.ok,
        semanticStatus: body.semanticStatus,
        replyText: body.reply?.text || null,
        replyImage: body.reply?.image || null,
        wallMs
      };
      // 幂等验证：再次 generate 应返回同一文本
      const again = await generate(rel.id);
      rec.idempotentText = again.body.reply?.text === rec.replyText;
      // destiny 抽查（注意：未解锁段经路由只返回元信息，不含 text——解锁语义保持不变）
      const dst = await (await fetch(`${BASE}/api/destiny/${rel.id}`)).json();
      rec.destiny = {
        location: dst.location,
        totalSegments: dst.totalSegments,
        seg1Unlocked: dst.segments?.[0]?.locked === false,
        seg2Locked: dst.segments?.[1]?.locked === true
      };
      // 回信与第4集同源：以库内 destinies.reply 对比 segments[3].text（权威版本）
      const Database = require(require.resolve('better-sqlite3', { paths: [path.join(ROOT, 'server')] }));
      const dbh = new Database(DB, { readonly: true });
      const dstRow = dbh.prepare('SELECT reply, segments FROM destinies WHERE record_id = ?').get(rel.id);
      dbh.close();
      rec.replyFromSeg4 = dstRow ? dstRow.reply === JSON.parse(dstRow.segments)[3]?.text : false;
      evidence.records.push(rec);
      console.log(`\n[verify] ${c.feeling}\n  status=${rec.semanticStatus} 幂等=${rec.idempotentText} 回信=第4集:${rec.replyFromSeg4} 地点=${rec.destiny.location}`);
    }

    // 真实配图路径：恰好一张，用生产函数 + 已冻结的 destinySummary
    // （本进程经 --env-file 持有真实图片配置；子服务进程被显式置空以控制成本）
    const ai = require(path.join(ROOT, 'server', 'ai'));
    const Database = require(require.resolve('better-sqlite3', { paths: [path.join(ROOT, 'server')] }));
    const dbh = new Database(DB, { readonly: true });
    const dstRow = dbh.prepare('SELECT * FROM destinies WHERE record_id = ?').get(evidence.records[0].recordId);
    dbh.close();
    const destinySummary = {
      location: dstRow.location,
      ending: dstRow.ending,
      visual: dstRow.visual,
      visualForImage: JSON.parse(dstRow.visual_for_image || '{}')
    };
    const t0 = Date.now();
    const image = await ai.generateReplyImage({
      feeling: evidence.records[0].input.feeling,
      creature: evidence.records[0].input.creature,
      water: evidence.records[0].input.water,
      destinySummary,
      replyText: evidence.records[0].replyText
    });
    evidence.image = { path: image, wallMs: Date.now() - t0, exists: image ? fs.existsSync(path.join(ROOT, 'server', 'public', image)) : false };
    console.log(`\n[verify] 真实配图: ${image} 存在=${evidence.image.exists} 耗时=${evidence.image.wallMs}ms`);

    evidence.finishedAt = new Date().toISOString();
    evidence.usageLedger = ai.getUsageLedger();
    fs.writeFileSync(path.join(OUT, 'evidence.json'), JSON.stringify(evidence, null, 2));
    console.log('\n[verify] 证据已写入 docs/jev-eval/real-path/evidence.json');
  } finally {
    server.kill('SIGTERM');
  }
})().catch(err => {
  console.error('[verify] 失败:', err);
  server.kill('SIGTERM');
  process.exit(1);
});
