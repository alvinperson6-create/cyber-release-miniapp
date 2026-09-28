const API_BASE = 'http://localhost:3001/api';
const TEST_OPENID = 'test-user-cases-' + Date.now();

const cases = [
  { feeling: '明天要考试，焦虑到失眠', creature: 'koi', water: 'xihu' },
  { feeling: '刚分手，心里空落落的', creature: 'turtle', water: 'baikal' },
  { feeling: '老板又临时加需求，烦死了', creature: 'cloud', water: 'pacific' },
  { feeling: '今天收到offer，开心到想转圈', creature: 'koi', water: 'arctic' },
  { feeling: '人生好迷茫，不知道往哪走', creature: 'turtle', water: 'xiang' }
];

async function apiRelease(payload) {
  const res = await fetch(`${API_BASE}/release`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ openid: TEST_OPENID, feedbackTime: '24h', ...payload })
  });
  return res.json();
}

async function apiGenerateReply(id) {
  const res = await fetch(`${API_BASE}/reply/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id })
  });
  return res.json();
}

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

(async () => {
  const results = [];

  // 1. 创建记录
  for (const c of cases) {
    const rec = await apiRelease(c);
    if (!rec.id) {
      console.log('create failed', c, rec);
    }
    results.push({ input: c, record: rec });
    console.log('created', rec.id);
  }

  // 2. 依次生成回信，避免并发限制
  for (const r of results) {
    try {
      const reply = await apiGenerateReply(r.record.id);
      r.replyResult = reply;
      console.log('generated', r.record.id, reply.ok ? 'ok' : 'fail');
    } catch (e) {
      r.replyResult = { ok: false, error: e.message };
      console.log('generated', r.record.id, 'error', e.message);
    }
    await sleep(2000);
  }

  // 3. 查询最终数据
  for (const r of results) {
    const res = await fetch(`${API_BASE}/records?openid=${TEST_OPENID}`);
    const data = await res.json();
    const rec = data.records.find(x => x.id === r.record.id);
    r.final = rec;
  }

  // 4. 输出 markdown
  console.log('\n\n===== 测试结果 =====\n');
  for (const r of results) {
    const rec = r.final || r.record;
    console.log(`## 用例：${r.input.feeling}`);
    console.log(`- 生物：${r.input.creature}`);
    console.log(`- 水域：${r.input.water}`);
    console.log(`- 记录ID：${rec.id}`);
    console.log(`- 回信状态：${rec.reply ? '已回信' : '未回信'}`);
    if (rec.reply) {
      console.log(`- 回信文字：${rec.reply.text}`);
      console.log(`- 配图路径：${rec.reply.image || '无'}`);
    }
    console.log('');
  }
})();
