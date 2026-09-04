const API_BASE = 'http://localhost:3001/api';
const TEST_OPENID = 'test-image-' + Date.now();

(async () => {
  const rec = await (await fetch(`${API_BASE}/release`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ openid: TEST_OPENID, feedbackTime: '24h', feeling: '明天要考试，焦虑到失眠', creature: 'koi', water: 'xihu' })
  })).json();

  console.log('created', rec.id);

  const reply = await (await fetch(`${API_BASE}/reply/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: rec.id })
  })).json();

  console.log('reply result', reply);

  const data = await (await fetch(`${API_BASE}/records?openid=${TEST_OPENID}`)).json();
  const final = data.records.find(x => x.id === rec.id);
  console.log('final image', final.reply?.image);
  console.log('final text', final.reply?.text);
})();
