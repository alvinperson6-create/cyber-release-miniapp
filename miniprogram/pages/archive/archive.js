// 赛博放生局 · 档案页
const {
  CREATURES, WATERS
} = require('../../utils/data.js');
const { loadRecords, getStats, checkPendingReplies } = require('../../utils/storage.js');
const { formatTime, formatCountdown } = require('../../utils/util.js');

Page({
  data: {
    statusBarHeight: 20,
    navTotalHeight: 64,
    scrollHeight: 600,
    records: [],
    stats: { total: 0, pending: 0, replied: 0 }
  },

  countdownTimer: null,

  onLoad() {
    const sysInfo = wx.getSystemInfoSync();
    const screenWidth = sysInfo.screenWidth || 375;
    const windowHeight = sysInfo.windowHeight || 667;
    const statusBarHeight = sysInfo.statusBarHeight || 20;
    const rpxToPx = screenWidth / 750;

    const navBarContentHeight = 88 * rpxToPx;
    const navTotalHeight = statusBarHeight + navBarContentHeight;
    const scrollHeight = windowHeight - navTotalHeight;

    this.setData({ statusBarHeight, navTotalHeight, scrollHeight });
  },

  onShow() {
    this.loadData();
    this.startCountdown();
  },

  onHide() {
    this.stopCountdown();
  },

  onUnload() {
    this.stopCountdown();
  },

  // ==================== 数据加载 ====================
  loadData() {
    // 检查到期回信
    checkPendingReplies();

    const records = loadRecords();
    const stats = getStats();

    // 格式化记录用于展示
    const formattedRecords = records.map(r => {
      const creature = CREATURES[r.creature] || { name: r.creature, emoji: '🐟' };
      const water = WATERS[r.water] || { name: r.water };
      const hasReply = !!r.reply;

      return {
        id: r.id,
        creatureEmoji: creature.emoji,
        creatureName: creature.name,
        waterName: water.name,
        timeStr: formatTime(r.createdAt),
        feeling: r.feeling,
        feedbackLabel: r.feedbackLabel,
        reply: r.reply,
        replyAt: r.replyAt,
        countdown: hasReply ? '' : formatCountdown(r.replyAt - Date.now()),
        expanded: false
      };
    });

    this.setData({ records: formattedRecords, stats });
  },

  // ==================== 倒计时 ====================
  startCountdown() {
    this.stopCountdown();
    this.countdownTimer = setInterval(() => {
      this.updateCountdowns();
    }, 1000);
  },

  stopCountdown() {
    if (this.countdownTimer) {
      clearInterval(this.countdownTimer);
      this.countdownTimer = null;
    }
  },

  updateCountdowns() {
    // 检查是否有回信到期
    const changed = checkPendingReplies();
    if (changed) {
      this.loadData();
      return;
    }

    // 更新倒计时显示
    const records = this.data.records;
    let needUpdate = false;
    const updated = records.map(r => {
      if (!r.reply && r.replyAt) {
        const newCountdown = formatCountdown(r.replyAt - Date.now());
        if (newCountdown !== r.countdown) {
          needUpdate = true;
          return { ...r, countdown: newCountdown };
        }
      }
      return r;
    });

    if (needUpdate) {
      this.setData({ records: updated });
    }
  },

  // ==================== 卡片交互 ====================
  onCardTap(e) {
    const idx = e.currentTarget.dataset.idx;
    const records = this.data.records;
    const record = records[idx];

    // 只有已回信的卡片可以展开/收起
    if (!record.reply) return;

    records[idx].expanded = !records[idx].expanded;
    this.setData({ records });
  },

  // ==================== 分享 ====================
  onShareAppMessage() {
    return {
      title: '赛博放生局 · 我的电子放生档案',
      path: '/pages/archive/archive'
    };
  }
});
