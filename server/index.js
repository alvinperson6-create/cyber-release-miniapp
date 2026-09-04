const express = require('express');
const cors = require('cors');
const path = require('path');
const { initDb } = require('./db');
const { isAIEnabled } = require('./ai');
const { PRE_GENERATE_MS, generateReplyForRecord } = require('./reply-generator');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

// 托管本地生成的图片
app.use('/images', express.static(path.join(__dirname, 'public', 'images')));

// 托管前端公共资源（three.js 本地 vendor、globe 配置等）
app.use(express.static(path.join(__dirname, 'public')));

// 托管静态网页（项目根目录的 web-app.html）
const WEB_DIR = path.join(__dirname, '..');
app.use(express.static(WEB_DIR));

// 首页默认跳转到 web-app.html
app.get('/', (req, res) => {
  res.sendFile(path.join(WEB_DIR, 'web-app.html'));
});

// Routes
app.use('/api/release', require('./routes/release'));
app.use('/api/records', require('./routes/records'));
app.use('/api/reply', require('./routes/reply'));
app.use('/api/destiny', require('./routes/destiny'));
app.use('/api/world', require('./routes/world'));

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString(), aiEnabled: isAIEnabled() });
});

// Initialize DB
initDb();

console.log(`[ai] ${isAIEnabled() ? 'AI 已启用' : 'AI 未启用（使用本地模板兜底，设置 AI_API_KEY 启用真实 AI）'}`);

// Check pending replies every 10 seconds
// 在回信到期前 PRE_GENERATE_MS 就开始生成，到点即可直接推送
setInterval(async () => {
  const { getPendingReplies } = require('./db');
  const pending = getPendingReplies(1, PRE_GENERATE_MS);
  for (const r of pending) {
    try {
      await generateReplyForRecord(r);
      console.log(`[reply] pre-generated reply for ${r.id}`);
    } catch (err) {
      console.error(`[reply] generation failed for ${r.id}:`, err.message);
    }
  }
}, 10000);

app.listen(PORT, () => {
  console.log(`赛博放生 API running at http://localhost:${PORT}`);
});
