const express = require('express');
const cors = require('cors');
const { initDb } = require('./db');
const { REPLY_POOL } = require('./data');

const app = express();
const PORT = 3000;

app.use(cors());
app.use(express.json());

// Routes
app.use('/api/release', require('./routes/release'));
app.use('/api/records', require('./routes/records'));
app.use('/api/reply', require('./routes/reply'));

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

// Initialize DB
initDb();

// Check pending replies every 10 seconds
setInterval(() => {
  const { getPendingReplies, updateReply } = require('./db');
  const pending = getPendingReplies();
  pending.forEach(r => {
    const reply = REPLY_POOL[Math.floor(Math.random() * REPLY_POOL.length)];
    updateReply(r.id, reply);
  });
  if (pending.length > 0) {
    console.log(`[reply] Generated ${pending.length} replies`);
  }
}, 10000);

app.listen(PORT, () => {
  console.log(`赛博放生局 API running at http://localhost:${PORT}`);
});
