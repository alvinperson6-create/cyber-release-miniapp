// 赛博放生 · createApp(runtime)
//
// 阶段 A：提取无启动副作用的应用装配。
// 导入本模块不监听端口、不启动 timer、不连生产库、不触发模型。
// production、HTTP 测试与场景开发服务共用本函数，因此 HTTP 验证覆盖的是
// **真实**静态服务、session 中间件、路由与错误处理，而不是另建一套装配。
//
// 阶段 A 的安全要求：静态服务只公开明确的 H5 文件与必要公共资源。
// 不能公开仓库源码、serving、legacy、运行数据库、测试产物或 fixture 控制面。

const express = require('express');
const cors = require('cors');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const RENDERER_DIR = path.join(REPO_ROOT, 'renderer');

const { createSessionMiddleware } = require('./session');
const { createApiRouter } = require('./api-router');
const { CONTRACT_VERSION } = require('../../shared/contracts/dto');

/**
 * 明确允许公开的静态资源：URL 前缀 → renderer/assets 下的子路径
 *
 * 只挂载这张表里的条目，而不是整个仓库根目录。
 * 私有路径（server/、serving/、legacy/、tests/、docs/、node_modules/、*.db、.env）
 * 因此不会出现在静态服务与 SPA fallback 里。
 */
const PUBLIC_ASSETS = [
  { url: '/vendor', dir: 'vendor', index: false },
  { url: '/images', dir: 'images', index: false },
  { url: '/globe3d.js', file: 'globe3d.js' },
  { url: '/globe-config.json', file: 'globe-config.json' },
  { url: '/world-land.json', file: 'world-land.json' }
];

// 供 tooling/frontend-check.js 与文档引用
const PUBLIC_ASSET_PREFIXES = PUBLIC_ASSETS.map(a => a.url);

/**
 * @param runtime createRuntime() 的返回值
 * @param opts.staticDir 覆盖静态根目录（测试用；其下应含 assets/）
 */
function createApp(runtime, opts = {}) {
  const app = express();
  const staticDir = opts.staticDir || RENDERER_DIR;
  const assetsDir = path.join(staticDir, 'assets');

  app.disable('x-powered-by');
  app.use(cors({ credentials: true, origin: true }));
  app.use(express.json({ limit: '256kb' }));

  // —— 公开静态资源（白名单）——
  for (const a of PUBLIC_ASSETS) {
    if (a.file) {
      // 单个文件：显式提供，不挂目录
      app.get(a.url, (req, res) => res.sendFile(path.join(assetsDir, a.file)));
    } else {
      app.use(a.url, express.static(path.join(assetsDir, a.dir), {
        index: a.index,
        fallthrough: true,
        dotfiles: 'deny'
      }));
    }
  }

  // H5 入口：只提供明确的那一个文件
  app.get('/', (req, res) => {
    res.sendFile(path.join(staticDir, 'index.html'));
  });
  app.get('/index.html', (req, res) => {
    res.sendFile(path.join(staticDir, 'index.html'));
  });

  // 会话：服务端签发 HttpOnly 匿名凭据，绑定所有者
  app.use('/api', createSessionMiddleware(runtime.store));

  // v2 API（真实装配：production 与测试共用）
  app.use('/api', createApiRouter(runtime));

  app.get('/api/health', (req, res) => {
    res.json({
      status: 'ok',
      time: new Date().toISOString(),
      contractVersion: CONTRACT_VERSION,
      aiEnabled: runtime.textModel.isEnabled(),
      jevEnabled: runtime.jev.isEnabled(),
      journeyV2: runtime.guards.journeyEnabled(),
      version: runtime.orchestrator.ORCHESTRATOR_VERSION
    });
  });

  // 未知 /api 路径：明确 404 JSON，不落到静态 fallback
  app.use('/api', (req, res) => {
    res.status(404).json({ ok: false, code: 'not_found', error: '接口不存在' });
  });

  // 统一错误处理：不泄漏堆栈给客户端
  app.use((err, req, res, next) => {
    console.error('[server] error:', err.message);
    if (res.headersSent) return next(err);
    res.status(500).json({ ok: false, code: 'internal_error', error: '服务器内部错误' });
  });

  return app;
}

module.exports = { createApp, REPO_ROOT, RENDERER_DIR, PUBLIC_ASSET_PREFIXES };
