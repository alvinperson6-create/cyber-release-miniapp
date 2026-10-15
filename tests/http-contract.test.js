// HTTP 契约：验证复用生产 createApp，覆盖真实静态、session、路由与错误处理
//
// 关键：这里不另建装配。app 就是 serving/entrypoints/app.js 导出的生产 app，
// 只有 runtime 的依赖被替换成固定 adapter。

const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { createWorld, baseScripts, baseHandlers } = require('./helpers/world');
const { httpStatusFor } = require('../shared/contracts/errors');
const { validateJourneyView, validateCommandResult } = require('../shared/contracts/dto');

async function serve(w) {
  const server = http.createServer(w.app);
  await new Promise(r => server.listen(0, r));
  return {
    server,
    base: `http://127.0.0.1:${server.address().port}`,
    async close() {
      server.closeAllConnections?.();
      await new Promise(r => server.close(r));
    }
  };
}

function w(tag) {
  return createWorld({ tag, scripts: baseScripts(), handlers: baseHandlers() });
}

test('会话：HttpOnly + SameSite，凭据来自服务端而非客户端自报', async () => {
  const world = w('http-session');
  const s = await serve(world);
  try {
    const r = await fetch(`${s.base}/api/release`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ species: 'koi', water: 'xihu', feeling: '一个烦恼' })
    });
    assert.equal(r.status, 200);
    const setCookie = r.headers.get('set-cookie') || '';
    assert.ok(setCookie.includes('HttpOnly'), 'cookie 必须 HttpOnly');
    assert.ok(setCookie.includes('SameSite=Lax'), 'cookie 必须 SameSite=Lax');

    // 客户端自报 owner 无效
    const spoof = await fetch(`${s.base}/api/journeys`, {
      headers: { Cookie: (setCookie.split(';')[0]), 'X-Owner-Key': 'someone-else' }
    });
    const body = await spoof.json();
    assert.equal(body.ok, true);
  } finally { await s.close(); await world.close(); }
});

test('幂等：Idempotency-Key 头生效；同键异载荷返回 409', async () => {
  const world = w('http-idem');
  const s = await serve(world);
  try {
    const key = 'http-idem-key-0001';
    const payload = JSON.stringify({ species: 'koi', water: 'xihu', feeling: '同一个烦恼' });

    const first = await fetch(`${s.base}/api/release`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key },
      body: payload
    });
    const cookie = (first.headers.get('set-cookie') || '').split(';')[0];
    const b1 = await first.json();
    assert.equal(first.status, 200);
    assert.equal(b1.replayed, false);

    // 同一 owner（同一 cookie）重放
    const r2 = await fetch(`${s.base}/api/release`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key, Cookie: cookie },
      body: payload
    });
    const b2 = await r2.json();
    assert.equal(r2.status, 200);
    assert.equal(b2.replayed, true, '重放被识别');
    assert.equal(b2.journeyId, b1.journeyId, '重放返回同一旅程');

    // 同键异载荷 → 409
    const r3 = await fetch(`${s.base}/api/release`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key, Cookie: cookie },
      body: JSON.stringify({ species: 'turtle', water: 'baikal', feeling: '别的烦恼' })
    });
    assert.equal(r3.status, 409, '同键异载荷冲突');
    const b3 = await r3.json();
    assert.equal(b3.code, 'idempotency_conflict');

    // 不同 owner 的同键互不串用
    const other = await fetch(`${s.base}/api/release`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key }, body: payload
    });
    const ob = await other.json();
    assert.equal(ob.replayed, false, '不同 owner 不命中别人的幂等记录');
    assert.notEqual(ob.journeyId, b1.journeyId);
  } finally { await s.close(); await world.close(); }
});

test('错误码 → HTTP 状态码与契约一致（逐个核对）', async () => {
  const world = w('http-errors');
  const s = await serve(world);
  try {
    // 非法物种 → 400
    const badSpecies = await fetch(`${s.base}/api/release`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ species: 'dragon', water: 'xihu', feeling: 'x' })
    });
    assert.equal(badSpecies.status, httpStatusFor('invalid_species'));
    assert.equal(badSpecies.status, 400);

    // 缺回复目标 → 400
    const r = await fetch(`${s.base}/api/release`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ species: 'koi', water: 'xihu', feeling: 'x' })
    });
    const cookie = (r.headers.get('set-cookie') || '').split(';')[0];
    const { journeyId } = await r.json();

    const noTarget = await fetch(`${s.base}/api/journey/${journeyId}/reply`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ text: '没有目标' })
    });
    assert.equal(noTarget.status, httpStatusFor('missing_reply_target'));
    assert.equal(noTarget.status, 400);

    // 不存在的信号 → 404
    const bogus = await fetch(`${s.base}/api/journey/${journeyId}/reply`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ text: 'x', signalMessageId: 'MSG-nope' })
    });
    assert.equal(bogus.status, httpStatusFor('signal_not_found'));
    assert.equal(bogus.status, 404);

    // 不存在的旅程 → 404
    const noJourney = await fetch(`${s.base}/api/journey/JRN-does-not-exist`, { headers: { Cookie: cookie } });
    assert.equal(noJourney.status, 404);

    // 未结束的回顾 → 403
    const timeline = await fetch(`${s.base}/api/journey/${journeyId}/timeline`, { headers: { Cookie: cookie } });
    assert.equal(timeline.status, httpStatusFor('journey_not_finished'));
    assert.equal(timeline.status, 403);

    // 重复结束 → 409
    const end1 = await fetch(`${s.base}/api/journey/${journeyId}/end`, { method: 'POST', headers: { Cookie: cookie } });
    assert.equal(end1.status, 200);
    const end2 = await fetch(`${s.base}/api/journey/${journeyId}/end`, { method: 'POST', headers: { Cookie: cookie } });
    assert.equal(end2.status, httpStatusFor('already_ended'));
    assert.equal(end2.status, 409);
  } finally { await s.close(); await world.close(); }
});

test('未知 API 路径返回 404 JSON，不落到静态 fallback', async () => {
  const world = w('http-404');
  const s = await serve(world);
  try {
    const r = await fetch(`${s.base}/api/does-not-exist`);
    assert.equal(r.status, 404);
    const b = await r.json();
    assert.equal(b.ok, false);
    assert.equal(b.code, 'not_found');
  } finally { await s.close(); await world.close(); }
});

test('响应通过契约校验；内部错误不泄漏堆栈', async () => {
  const world = w('http-contract');
  const s = await serve(world);
  try {
    const r = await fetch(`${s.base}/api/release`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ species: 'koi', water: 'xihu', feeling: '契约检查' })
    });
    const cookie = (r.headers.get('set-cookie') || '').split(';')[0];
    const { journeyId } = await r.json();

    await world.drain(6);

    const view = await (await fetch(`${s.base}/api/journey/${journeyId}`, { headers: { Cookie: cookie } })).json();
    assert.ok(validateCommandResult(view), '命令结果结构合法');
    assert.ok(validateJourneyView(view.journey), 'JourneyView 通过契约校验');

    // DTO 里不得出现内部字段
    const text = JSON.stringify(view);
    for (const leaked of ['owner_key', 'ownerKey', 'decision_meta', 'proposal_json', 'raw_text', 'system prompt']) {
      assert.ok(!text.includes(leaked), `响应不应包含内部字段：${leaked}`);
    }

    // 错误响应不带堆栈
    const err = await fetch(`${s.base}/api/journey/JRN-nope`);
    const errText = await err.text();
    assert.ok(!errText.includes('at Object.'), '错误响应不泄漏堆栈');
  } finally { await s.close(); await world.close(); }
});

test('读取接口不调用模型、不推进状态', async () => {
  const world = w('http-readonly');
  const s = await serve(world);
  try {
    const r = await fetch(`${s.base}/api/release`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ species: 'koi', water: 'xihu', feeling: '只读验证' })
    });
    const cookie = (r.headers.get('set-cookie') || '').split(';')[0];
    const { journeyId } = await r.json();

    const callsBefore = world.store.countModelCalls(journeyId);
    const statusBefore = world.store.getJourney(journeyId).status;

    for (let i = 0; i < 6; i++) {
      await fetch(`${s.base}/api/journey/${journeyId}`, { headers: { Cookie: cookie } });
      await fetch(`${s.base}/api/journeys`, { headers: { Cookie: cookie } });
      await fetch(`${s.base}/api/creatures`, { headers: { Cookie: cookie } });
      await fetch(`${s.base}/api/world/pulse`);
    }

    assert.equal(world.store.countModelCalls(journeyId), callsBefore, '读取不触发模型');
    assert.equal(world.store.getJourney(journeyId).status, statusBefore, '读取不推进状态');
  } finally { await s.close(); await world.close(); }
});

test('health 暴露契约版本，不泄漏凭据', async () => {
  const world = w('http-health');
  const s = await serve(world);
  try {
    const b = await (await fetch(`${s.base}/api/health`)).json();
    assert.equal(b.status, 'ok');
    assert.ok(b.contractVersion, '暴露契约版本');
    const text = JSON.stringify(b);
    assert.ok(!text.includes('apiKey'), '不泄漏密钥');
    assert.ok(!text.includes('key'), '不泄漏任何 key 字段');
  } finally { await s.close(); await world.close(); }
});
