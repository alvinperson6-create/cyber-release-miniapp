// 代理感知 HTTP 出口
//
// 为什么要单独测：JEV 按出口 IP 做地域限制，受限区域直连返回 451。
// 这一层如果出错，表现是"配了代理但请求还是本地出口"——非常难排查，
// 所以把协议选择、优先级、占位值、未配置回落逐条钉住。

const { test } = require('node:test');
const assert = require('node:assert');
const { resolveProxyUrl, createHttpClient, resetProxyCache } = require('../serving/adapters/http-client');

/** 干净地设置/清理代理环境变量 */
function withProxyEnv(vars, fn) {
  const saved = {};
  for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy']) {
    saved[k] = process.env[k];
    if (vars[k] === undefined) delete process.env[k];
    else process.env[k] = vars[k];
  }
  try { return fn(); } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    resetProxyCache();
  }
}

test('https 请求只用 HTTPS 代理（HTTP_PROXY 不得干扰）', () => {
  withProxyEnv({
    HTTP_PROXY: 'http://127.0.0.1:1111',
    HTTPS_PROXY: 'http://127.0.0.1:2222',
    http_proxy: 'http://127.0.0.1:1111',
    https_proxy: 'http://127.0.0.1:2222'
  }, () => {
    assert.equal(resolveProxyUrl(null, 'https://api.typesafe.ai/v1'), 'http://127.0.0.1:2222');
    // http 请求才允许回落到 HTTP_PROXY
    assert.equal(resolveProxyUrl(null, 'http://example.com'), 'http://127.0.0.1:2222');
  });
});

test('https 请求不会被小写 http_proxy 污染', () => {
  // 这正是本轮踩到的坑：IDE/容器注入 http_proxy 指向另一个代理，
  // 导致"明明设了 HTTPS_PROXY 却仍走错出口"
  withProxyEnv({
    http_proxy: 'http://127.0.0.1:58410',
    HTTPS_PROXY: 'http://127.0.0.1:7897'
  }, () => {
    assert.equal(resolveProxyUrl(null, 'https://api.typesafe.ai/v1'), 'http://127.0.0.1:7897');
  });
});

test('显式参数优先于所有环境变量', () => {
  withProxyEnv({ HTTPS_PROXY: 'http://127.0.0.1:2222' }, () => {
    assert.equal(resolveProxyUrl('http://127.0.0.1:9999', 'https://x.com'), 'http://127.0.0.1:9999');
  });
});

test('占位值不算代理', () => {
  for (const v of ['0', 'false', 'none', 'off', 'OFF', '']) {
    withProxyEnv({ HTTPS_PROXY: v }, () => {
      assert.equal(resolveProxyUrl(null, 'https://x.com'), null, `"${v}" 应被视为未配置`);
    });
  }
});

test('未配置代理 → 回落到裸 fetch，不加载 undici', async () => {
  await withProxyEnv({ HTTPS_PROXY: undefined, HTTPS_PROXY: undefined, https_proxy: undefined }, async () => {
    resetProxyCache();
    const c = await createHttpClient({ url: 'https://api.typesafe.ai/v1' });
    assert.equal(c.proxied, false);
    assert.equal(c.proxyUrl, null);
    assert.equal(c.fetch, globalThis.fetch, '未配置时必须与裸 fetch 同一引用');
  });
});

test('配置代理 → 返回 undici 包装的 fetch（不静默回落直连）', async () => {
  await withProxyEnv({ HTTPS_PROXY: 'http://127.0.0.1:7897' }, async () => {
    resetProxyCache();
    const c = await createHttpClient({ url: 'https://api.typesafe.ai/v1' });
    assert.equal(c.proxied, true);
    assert.equal(c.proxyUrl, 'http://127.0.0.1:7897');
    assert.notEqual(c.fetch, globalThis.fetch, '必须换成带 dispatcher 的实现');
  });
});

test('显式 proxyUrl=null 时会读环境变量（JEV_PROXY 未设时的预期行为）', async () => {
  await withProxyEnv({ HTTPS_PROXY: 'http://127.0.0.1:7897' }, async () => {
    resetProxyCache();
    const c = await createHttpClient({ proxyUrl: null, url: 'https://x.com' });
    assert.equal(c.proxyUrl, 'http://127.0.0.1:7897');
  });
});

test('JEV 适配器读取 JEV_PROXY 且默认不配置', () => {
  const { getConfig } = require('../serving/adapters/jev');
  const saved = process.env.JEV_PROXY;
  try {
    delete process.env.JEV_PROXY;
    assert.equal(getConfig().proxyUrl, null, '未配置时为 null（直连）');
    process.env.JEV_PROXY = 'http://127.0.0.1:7897';
    assert.equal(getConfig().proxyUrl, 'http://127.0.0.1:7897');
  } finally {
    if (saved === undefined) delete process.env.JEV_PROXY; else process.env.JEV_PROXY = saved;
  }
});