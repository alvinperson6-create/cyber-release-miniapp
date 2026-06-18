// utils/storage.js — 本地存储管理

const { REPLY_POOL } = require('./data');

const STORAGE_KEY = 'records';

// 读取所有记录
function getRecords() {
  try {
    return wx.getStorageSync(STORAGE_KEY) || [];
  } catch (e) {
    return [];
  }
}

// 保存所有记录
function saveRecords(records) {
  wx.setStorageSync(STORAGE_KEY, records);
}

// 添加一条记录
function addRecord(record) {
  const records = getRecords();
  records.unshift(record);
  saveRecords(records);
}

// 更新记录（到点生成回信）
function checkPendingReplies() {
  const records = getRecords();
  let changed = false;
  const now = Date.now();
  records.forEach(r => {
    if (!r.reply && now >= r.replyAt) {
      r.reply = generateReply();
      changed = true;
    }
  });
  if (changed) {
    saveRecords(records);
  }
  return changed;
}

// 随机生成 AI 回信
function generateReply() {
  return REPLY_POOL[Math.floor(Math.random() * REPLY_POOL.length)];
}

// 首次访问注入 demo 数据
function seedDemoData() {
  if (getRecords().length > 0) return;
  const now = Date.now();
  const demo = [
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
      createdAt: now - 1800 * 1000,
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
  saveRecords(demo);
}

// 统计
function getStats() {
  const records = getRecords();
  const total = records.length;
  const pending = records.filter(r => !r.reply).length;
  const replied = total - pending;
  return { total, pending, replied };
}

module.exports = {
  getRecords,
  saveRecords,
  addRecord,
  checkPendingReplies,
  generateReply,
  seedDemoData,
  getStats
};
