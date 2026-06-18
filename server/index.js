const express = require('express');
const cors = require('cors');
const path = require('path');
const { initDb } = require('./db');
const { generateReply, generateDestiny, isAIEnabled } = require('./ai');
const { insertDestiny } = require('./db');

const app = express();
const PORT = 3000;

app.use(cors());
app.use(express.json());

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

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString(), aiEnabled: isAIEnabled() });
});

// Initialize DB
initDb();

console.log(`[ai] ${isAIEnabled() ? 'AI 已启用' : 'AI 未启用（使用本地模板兜底，设置 AI_API_KEY 启用真实 AI）'}`);

// Check pending replies every 10 seconds
// 到期的放生记录会自动生成 AI 回信 + 命运轨迹
setInterval(async () => {
  const { getPendingReplies, updateReply, getDestinyByRecordId } = require('./db');
  const pending = getPendingReplies();
  for (const r of pending) {
    try {
      const reply = await generateReply({
        feeling: r.feeling,
        creature: r.creature,
        water: r.water
      });
      updateReply(r.id, reply);

      // 同步生成命运轨迹（若不存在）
      if (!getDestinyByRecordId(r.id)) {
        try {
          const segments = await generateDestiny({
            feeling: r.feeling,
            creature: r.creature,
            water: r.water
          });
          insertDestiny({
            id: `DST-${r.id}`,
            recordId: r.id,
            openid: r.openid,
            segments
          });
        } catch (e) {
          console.warn(`[reply] destiny generation failed for ${r.id}:`, e.message);
        }
      }
    } catch (err) {
      console.error(`[reply] generation failed for ${r.id}:`, err.message);
    }
  }
  if (pending.length > 0) {
    console.log(`[reply] Generated ${pending.length} AI replies`);
  }
}, 10000);

app.listen(PORT, () => {
  console.log(`赛博放生局 API running at http://localhost:${PORT}`);
});
