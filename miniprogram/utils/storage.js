// 赛博放生局 · 本地存储封装
// 使用 wx.setStorageSync / wx.getStorageSync 持久化放生记录
const { REPLY_POOL, CREATURES } = require('./data.js');

const STORAGE_KEY = 'cyber_release_records';
const DESTINY_KEY = 'cyber_release_destinies';

// ==================== 基础读写 ====================
function loadRecords() {
  try {
    return wx.getStorageSync(STORAGE_KEY) || [];
  } catch (e) {
    return [];
  }
}

function saveRecords(records) {
  try {
    wx.setStorageSync(STORAGE_KEY, records);
  } catch (e) {
    console.warn('保存记录失败', e);
  }
}

function addRecord(record) {
  const records = loadRecords();
  records.unshift(record);
  saveRecords(records);
}

function getStats() {
  const records = loadRecords();
  const total = records.length;
  const pending = records.filter(r => !r.reply).length;
  const replied = total - pending;
  return { total, pending, replied };
}

// ==================== 回信生成 ====================
function generateReply() {
  return REPLY_POOL[Math.floor(Math.random() * REPLY_POOL.length)];
}

// 检查待回信记录是否到时, 自动生成回信
function checkPendingReplies() {
  const records = loadRecords();
  let changed = false;
  records.forEach(r => {
    if (!r.reply && Date.now() >= r.replyAt) {
      r.reply = generateReply();
      changed = true;
    }
  });
  if (changed) {
    saveRecords(records);
  }
  return changed;
}

// ==================== Demo 数据种子 ====================
function seedDemoData() {
  if (loadRecords().length > 0) return;
  const now = Date.now();
  const demoRecords = [
    {
      id: 'CRSB-20260615-2847',
      creature: 'koi', water: 'xihu',
      feeling: '明天答辩，紧张到胃疼...',
      feedbackLabel: '24 小时后',
      createdAt: now - 26 * 3600 * 1000,
      replyAt: now - 2 * 3600 * 1000,
      reply: {
        bg: 'linear-gradient(135deg, #d4e8e2, #a9d2c5)',
        emoji: '🌅',
        text: '嘿，昨晚的西湖锦鲤替你游了一圈。它说答辩那天你会比想象中镇定——不是因为不紧张了，而是因为你已经紧张过了，该轮到镇定了。胃不疼了吧？'
      }
    },
    {
      id: 'CRSB-20260616-3912',
      creature: 'turtle', water: 'mariana',
      feeling: '项目今天上线，手心一直在出汗...',
      feedbackLabel: '24 小时后',
      createdAt: now - 0.5 * 3600 * 1000,
      replyAt: now + 23.5 * 3600 * 1000,
      reply: null
    },
    {
      id: 'CRSB-20260614-1023',
      creature: 'cloud', water: 'baikal',
      feeling: '凌晨三点了还是睡不着，想太多...',
      feedbackLabel: '24 小时后',
      createdAt: now - 50 * 3600 * 1000,
      replyAt: now - 26 * 3600 * 1000,
      reply: {
        bg: 'linear-gradient(135deg, #c7dbe2, #9bc8bd)',
        emoji: '🌙',
        text: '贝加尔湖的云朵飘过来说：你凌晨三点想的事，有 90% 不会发生。剩下 10% 发生了你也管不了。它替你把那 90% 装走了，今晚试试能不能早点闭眼。'
      }
    },
    {
      id: 'CRSB-20260612-0568',
      creature: 'koi', water: 'pacific',
      feeling: '今天被老板否了第三版方案...',
      feedbackLabel: '24 小时后',
      createdAt: now - 96 * 3600 * 1000,
      replyAt: now - 72 * 3600 * 1000,
      reply: {
        bg: 'linear-gradient(135deg, #f9d8c9, #ed7d5b)',
        emoji: '🔥',
        text: '太平洋的锦鲤回信了：老板否了三版，说明你在尝试。它替你数了一下——第三版被否的人，第四版过的概率是 67%。你已经在路上了，别停下来。'
      }
    }
  ];
  saveRecords(demoRecords);
}

// ==================== 命运轨迹 (本地兜底) ====================
function loadDestinies() {
  try {
    return wx.getStorageSync(DESTINY_KEY) || {};
  } catch (e) {
    return {};
  }
}

function saveDestinies(d) {
  try {
    wx.setStorageSync(DESTINY_KEY, d);
  } catch (e) {
    console.warn('保存命运轨迹失败', e);
  }
}

// 本地命运轨迹模板生成（与 server/ai.js templateDestiny 保持一致）
function generateDestinySegments(creature) {
  const creatureName = (CREATURES[creature] && CREATURES[creature].name) || '电子生物';
  const palettes = [
    { bg: 'linear-gradient(135deg, #d4e8e2, #a9d2c5)', emoji: '🌿' },
    { bg: 'linear-gradient(135deg, #c7dbe2, #9bc8bd)', emoji: '🌊' },
    { bg: 'linear-gradient(135deg, #f9d8c9, #ed7d5b)', emoji: '🔥' },
    { bg: 'linear-gradient(135deg, #e8d5f0, #c4a8d8)', emoji: '✨' }
  ];
  const arcs = {
    koi: [
      { title: '入水瞬间', text: creatureName + '从你的掌心滑进水域，鳞片在光里闪了一下。它没有回头，但摆了摆尾巴，像是在说"放心"。' },
      { title: '顺流而下', text: '水流比想象中温柔。它穿过一片水草，遇见一群透明的小鱼，它们互相打了个照面，又各自游开。' },
      { title: '一次回望', text: '在某个转弯处它停了一下。它想起你写下那些字时的样子——它没法替你解决，但它决定替你记着。' },
      { title: '准备回信', text: '它找到一块温暖的礁石，靠着，开始想怎么把这一路的事讲给你听。回信已经在它嘴里成形了。' }
    ],
    turtle: [
      { title: '缓缓下沉', text: creatureName + '缩进壳里，慢慢沉到水底。光从上面一缕缕漏下来，它闭上眼，决定先休息一会儿。' },
      { title: '海底漫步', text: '它在沙地上一步一步走，比谁都慢，但每一步都稳。遇到一只水母，它从水母下面钻过去，像过一扇门。' },
      { title: '一个决定', text: '它想起你写下的那些话。它想：慢不是错，方向对就行。它决定把这个想法带回去给你。' },
      { title: '浮出水面', text: '它开始往上浮，气泡一颗颗从嘴边冒出去。它要去找一张干净的纸，把回信写下来。' }
    ],
    cloud: [
      { title: '升上天空', text: creatureName + '从你手心飘起来，越飘越高，最后停在水域上空。它低头看了你一眼，然后被风推着走了。' },
      { title: '随风漂泊', text: '它路过一座山，又路过一片云。云和云之间互相点头，像在说"你也来啦"。它觉得自己轻了一点。' },
      { title: '装下你的事', text: '它把你写下的那些事装进自己身体里。装着装着，它发现自己变重了——但不是坏事，是那种被需要的重。' },
      { title: '化作回信', text: '它飘回水域上空，把自己拧了拧，拧出一封回信，轻轻丢向你的方向。' }
    ]
  };
  const list = arcs[creature] || arcs.koi;
  return list.map((seg, i) => ({
    title: seg.title,
    text: seg.text,
    emoji: palettes[i % palettes.length].emoji,
    bg: palettes[i % palettes.length].bg
  }));
}

function getDestiny(recordId) {
  const destinies = loadDestinies();
  const records = loadRecords();
  const record = records.find(r => r.id === recordId);
  if (!record) return { error: '记录不存在' };

  if (!destinies[recordId]) {
    destinies[recordId] = {
      id: 'DST-' + recordId,
      recordId: recordId,
      segments: generateDestinySegments(record.creature),
      unlockedIndices: [0],
      createdAt: Date.now()
    };
    saveDestinies(destinies);
  }
  const d = destinies[recordId];
  const unlocked = {};
  d.unlockedIndices.forEach(i => { unlocked[i] = true; });
  const segments = d.segments.map((seg, i) => {
    if (unlocked[i]) {
      return Object.assign({}, seg, { index: i, locked: false });
    }
    return { index: i, title: seg.title, emoji: seg.emoji, bg: seg.bg, locked: true, unlockType: i === 0 ? 'free' : 'ad' };
  });
  return {
    id: d.id,
    recordId: d.recordId,
    segments: segments,
    totalSegments: segments.length,
    unlockedCount: segments.filter(s => !s.locked).length,
    allUnlocked: segments.every(s => !s.locked),
    adDurationMs: 15000
  };
}

function unlockDestiny(recordId, mode, index) {
  const destinies = loadDestinies();
  const d = destinies[recordId];
  if (!d) return { error: '命运轨迹不存在' };
  const total = d.segments.length;
  const current = {};
  d.unlockedIndices.forEach(i => { current[i] = true; });

  if (mode === 'bundle') {
    if (d.unlockedIndices.length >= total) {
      return { ok: true, alreadyUnlocked: true, unlockedIndices: d.unlockedIndices.slice().sort((a,b)=>a-b) };
    }
    const all = [];
    for (let i = 0; i < total; i++) all.push(i);
    d.unlockedIndices = all;
    saveDestinies(destinies);
    return { ok: true, adId: 'LOCAL-AD-' + Date.now(), unlockedIndices: all, adWatched: true };
  }

  const idx = parseInt(index, 10);
  if (isNaN(idx) || idx < 0 || idx >= total) return { error: '无效索引' };
  if (current[idx]) {
    return { ok: true, alreadyUnlocked: true, unlockedIndices: d.unlockedIndices.slice().sort((a,b)=>a-b) };
  }
  d.unlockedIndices.push(idx);
  d.unlockedIndices.sort((a, b) => a - b);
  saveDestinies(destinies);
  return { ok: true, adId: 'LOCAL-AD-' + Date.now(), unlockedIndices: d.unlockedIndices, adWatched: idx !== 0 };
}

module.exports = {
  STORAGE_KEY,
  loadRecords,
  saveRecords,
  addRecord,
  getStats,
  generateReply,
  checkPendingReplies,
  seedDemoData,
  getDestiny,
  unlockDestiny
};
