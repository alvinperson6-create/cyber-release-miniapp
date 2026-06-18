// 赛博放生局 · API 层
// 优先使用 wx.request 调用后端, 失败时降级到 wx.storage 本地存储
const storage = require('./storage.js');

const API_BASE = 'http://localhost:3000/api';
const USE_API = false; // 后端运行时改为 true

// 复用 storage 模块的本地存储能力
const {
  loadRecords,
  saveRecords,
  addRecord,
  getStats,
  generateReply,
  checkPendingReplies,
  getDestiny,
  unlockDestiny
} = storage;

// ==================== API 调用 (带本地降级) ====================

// 放生
function apiRelease(data) {
  return new Promise((resolve) => {
    if (!USE_API) {
      addRecord(data);
      resolve({ ok: true, id: data.id });
      return;
    }
    wx.request({
      url: API_BASE + '/release',
      method: 'POST',
      header: { 'Content-Type': 'application/json' },
      data: data,
      success(res) {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(res.data);
        } else {
          addRecord(data);
          resolve({ ok: true, id: data.id });
        }
      },
      fail() {
        addRecord(data);
        resolve({ ok: true, id: data.id });
      }
    });
  });
}

// 获取记录列表
function apiGetRecords(openid) {
  return new Promise((resolve) => {
    if (!USE_API) {
      resolve({ records: loadRecords(), stats: getStats() });
      return;
    }
    wx.request({
      url: API_BASE + '/records?openid=' + encodeURIComponent(openid),
      method: 'GET',
      success(res) {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(res.data);
        } else {
          resolve({ records: loadRecords(), stats: getStats() });
        }
      },
      fail() {
        resolve({ records: loadRecords(), stats: getStats() });
      }
    });
  });
}

// 获取单条回信
function apiGetReply(id) {
  return new Promise((resolve) => {
    if (!USE_API) {
      const records = loadRecords();
      const r = records.find(x => x.id === id);
      resolve({ reply: r ? r.reply : null });
      return;
    }
    wx.request({
      url: API_BASE + '/reply/' + id,
      method: 'GET',
      success(res) {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(res.data);
        } else {
          const records = loadRecords();
          const r = records.find(x => x.id === id);
          resolve({ reply: r ? r.reply : null });
        }
      },
      fail() {
        const records = loadRecords();
        const r = records.find(x => x.id === id);
        resolve({ reply: r ? r.reply : null });
      }
    });
  });
}

// 获取命运轨迹
function apiGetDestiny(recordId) {
  return new Promise((resolve) => {
    if (!USE_API) {
      resolve(getDestiny(recordId));
      return;
    }
    wx.request({
      url: API_BASE + '/destiny/' + recordId,
      method: 'GET',
      success(res) {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(res.data);
        } else {
          resolve(getDestiny(recordId));
        }
      },
      fail() {
        resolve(getDestiny(recordId));
      }
    });
  });
}

// 解锁命运轨迹（mock 支付）
function apiUnlockDestiny(recordId, mode, index) {
  return new Promise((resolve) => {
    if (!USE_API) {
      resolve(unlockDestiny(recordId, mode, index));
      return;
    }
    wx.request({
      url: API_BASE + '/destiny/unlock',
      method: 'POST',
      header: { 'Content-Type': 'application/json' },
      data: {
        recordId,
        mode,
        index: mode === 'single' ? index : undefined,
        payToken: 'mock_pay_ok'
      },
      success(res) {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(res.data);
        } else {
          resolve(unlockDestiny(recordId, mode, index));
        }
      },
      fail() {
        resolve(unlockDestiny(recordId, mode, index));
      }
    });
  });
}

module.exports = {
  STORAGE_KEY: storage.STORAGE_KEY,
  loadRecords,
  saveRecords,
  addRecord,
  getStats,
  generateReply,
  checkPendingReplies,
  apiRelease,
  apiGetRecords,
  apiGetReply,
  apiGetDestiny,
  apiUnlockDestiny
};
