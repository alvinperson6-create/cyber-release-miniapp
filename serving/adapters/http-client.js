// 赛博放生 · 代理感知的 HTTP 出口
//
// 为什么需要它：JEV（typesafe.ai）按**请求出口 IP**做地域限制，从受限区域
// 直连会拿到 HTTP 451。系统代理（macOS 的 127.0.0.1:7897 等）能让请求走通，
// 但 Node 的 fetch **不读系统代理设置**，于是"浏览器能开、服务器连不上"。
//
// 边界：这是一个纯 IO 小工具，不含业务逻辑、不碰数据库。
// 显式配置才启用；未配置时行为与裸 fetch 完全一致。
//
// 优先级：模块参数 > HTTPS_PROXY > https_proxy > HTTP_PROXY > http_proxy
// HTTPS 请求**只用 HTTPS 代理**：CI / 容器 / IDE 沙箱常同时注入两组变量
// 且可能指向不同代理，误用会连到不该走的出口，表现为"配了代理但出口 IP 没变"。

let cachedAgentKey = null;
let cachedAgent = null;

/**
 * 解析出代理地址。
 * @param explicit    显式传入优先
 * @param requestUrl  目标 URL；https 请求只用 HTTPS 代理
 */
function resolveProxyUrl(explicit, requestUrl) {
  if (explicit) return String(explicit).trim() || null;
  const isHttps = String(requestUrl || '').toLowerCase().startsWith('https:');
  const candidates = isHttps
    ? [process.env.HTTPS_PROXY, process.env.https_proxy]
    : [process.env.HTTPS_PROXY, process.env.https_proxy, process.env.HTTP_PROXY, process.env.http_proxy];

  for (const raw of candidates) {
    const v = String(raw || '').trim();
    if (!v) continue;
    // 忽略占位值，避免把"设了但没配"当成真的代理
    if (['0', 'false', 'none', 'off'].includes(v.toLowerCase())) continue;
    return v;
  }
  return null;
}

/**
 * 创建一个按代理配置的 fetch。
 * @param opts.proxyUrl 显式代理地址；不给则读环境变量
 * @returns {{fetch: Function, proxied: boolean, proxyUrl: string|null}}
 */
async function createHttpClient(opts = {}) {
  const proxyUrl = resolveProxyUrl(opts.proxyUrl, opts.url);
  if (!proxyUrl) {
    // 未配置代理：不加载任何额外依赖，行为与裸 fetch 完全一致
    return { fetch: globalThis.fetch, proxied: false, proxyUrl: null };
  }

  // undici 提供 ProxyAgent。Node 25 的内置 --use-env-proxy 实测对本场景
  // 无效（无 flag / 仅 env / flag+env 三种组合都仍走本地出口），
  // 因此必须显式装 dispatcher。
  let undici;
  try {
    undici = require('undici');
  } catch (e) {
    // 拿不到就如实报错，不静默退回直连
    // （静默退回会让人以为"配了代理等于走了代理"，实际请求仍是本地出口）
    const err = new Error(
      `已配置代理（${proxyUrl}）但无法加载 undici，请在项目根目录执行：npm install undici`
    );
    err.code = 'PROXY_UNAVAILABLE';
    throw err;
  }

  // 按代理地址缓存 dispatcher：同一代理复用，避免每次请求新建连接池
  if (cachedAgentKey !== proxyUrl) {
    cachedAgentKey = proxyUrl;
    cachedAgent = new undici.ProxyAgent(proxyUrl, { connectTimeout: 15000 });
  }

  return {
    fetch: (url, init) => undici.fetch(url, { ...init, dispatcher: cachedAgent }),
    proxied: true,
    proxyUrl
  };
}

/** 测试用：清掉缓存的 agent */
function resetProxyCache() {
  cachedAgentKey = null;
  cachedAgent = null;
}

module.exports = { createHttpClient, resolveProxyUrl, resetProxyCache };