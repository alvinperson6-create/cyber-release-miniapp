// 赛博放生 · 服务入口（v2：单生物自主文字旅程）
//
// 旧入口（/api/destiny、POST /api/reply/generate、按 reply_at 预生成的调度、
// 旧 JOURNEY_ENABLED 分支）已停挂并随 legacy/story-v0/ 归档（handoff §4.3/§4.5）。

const express = require('express');
const cors = require('cors');
const path = require('path');
const { initDb } = require('./db');
const { isAIEnabled } = require('./ai');
const { sessionMiddleware } = require('./session');
const scheduler = require('./scheduler');
const { guards } = require('./flags');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors({ credentials: true, origin: true }));
app.use(express.json({ limit: '256kb' }));

// 托管本地生成的配图
app.use('/images', express.static(path.join(__dirname, 'public', 'images')));

// 托管前端公共资源（three.js vendor、globe 配置等）
app.use(express.static(path.join(__dirname, 'public')));

// 托管静态网页（项目根目录的 web-app.html）
const WEB_DIR = path.join(__dirname, '..');
app.use(express.static(WEB_DIR));

app.get('/', (req, res) => {
  res.sendFile(path.join(WEB_DIR, 'web-app.html'));
});

// 会话：服务端签发 HttpOnly 匿名凭据，绑定所有者（客户端自报 openid 不再作为授权）
app.use('/api', sessionMiddleware);

// v2 路由
app.use('/api/release', require('./routes/release'));
app.use('/api/journey', require('./routes/journey'));
app.use('/api/world', require('./routes/world'));

// 列表端点
app.get('/api/journeys', (req, res) => {
  try { res.json({ ok: true, journeys: require('./orchestrator').listJourneys(req.ownerKey) }); }
  catch (err) { res.status(500).json({ ok: false, error: '服务器内部错误' }); }
});
app.get('/api/creatures', (req, res) => {
  try { res.json({ ok: true, creatures: require('./orchestrator').listCreatures(req.ownerKey) }); }
  catch (err) { res.status(500).json({ ok: false, error: '服务器内部错误' }); }
});

app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    time: new Date().toISOString(),
    aiEnabled: isAIEnabled(),
    journeyV2: guards.journeyEnabled(),
    version: require('./orchestrator').ORCHESTRATOR_VERSION
  });
});

// 统一错误处理：不泄漏堆栈给客户端
app.use((err, req, res, next) => {
  console.error('[server] error:', err.message);
  if (res.headersSent) return next(err);
  res.status(500).json({ ok: false, error: '服务器内部错误' });
});

// Initialize DB
initDb();

console.log(`[ai] ${isAIEnabled() ? 'AI 已启用' : 'AI 未启用（旅程将无法开局，设置 AI_API_KEY 启用真实模型）'}`);

// 后台调度：页面关闭也推进；同一生产 tick 供测试/验证手动调用
scheduler.start();

app.listen(PORT, () => {
  console.log(`赛博放生 API (journey-v2) running at http://localhost:${PORT}`);
});
