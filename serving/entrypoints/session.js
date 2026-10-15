// 赛博放生 · 匿名会话与归属
//
// 服务端签发不可猜的凭据：HttpOnly + SameSite=Lax cookie。
// cookie 里只有随机 token；库中只存 token 的 sha256 与 owner_key。
// 客户端自报的 openid / 可猜记录 ID 一律不作为授权依据。
// 凭据值不写日志。
//
// ownerKey 从服务端会话获得，不接受客户端自报所有权。

const crypto = require('node:crypto');

const COOKIE_NAME = 'crsid';
const ONE_YEAR_S = 365 * 24 * 3600;

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function parseCookies(req) {
  const header = req.headers.cookie || '';
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

/**
 * 创建会话中间件。store 由 runtime 注入，不使用模块级单例，
 * 因此不同 runtime 的会话互不干扰。
 */
function createSessionMiddleware(store) {
  /** express 中间件：无有效会话则签发新凭据；req.ownerKey 供路由做归属校验 */
  return function sessionMiddleware(req, res, next) {
    const cookies = parseCookies(req);
    const token = cookies[COOKIE_NAME];
    let owner = null;
    if (token) {
      owner = store.getSessionByTokenHash(hashToken(token));
    }
    if (!owner) {
      const newToken = crypto.randomBytes(24).toString('base64url');
      const ownerKey = crypto.randomUUID();
      store.upsertSession(hashToken(newToken), ownerKey, Date.now());
      res.setHeader('Set-Cookie',
        `${COOKIE_NAME}=${newToken}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${ONE_YEAR_S}`);
      req.ownerKey = ownerKey;
      req.sessionNew = true;
      return next();
    }
    req.ownerKey = owner.owner_key;
    return next();
  };
}

module.exports = { createSessionMiddleware, COOKIE_NAME, hashToken };
