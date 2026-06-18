// 赛博放生局 · 命运轨迹页
const { apiGetDestiny, apiUnlockDestiny } = require('../../utils/api.js');

Page({
  data: {
    statusBarHeight: 20,
    scrollHeight: 600,
    recordId: '',
    loading: true,
    destiny: null,
    errorMsg: '',
    // 广告模拟弹窗
    adVisible: false,
    adCountdown: 0,
    adReady: false,
    adMode: '',       // 'single' | 'bundle'
    adIndex: -1
  },

  adTimer: null,

  onLoad(opts) {
    const sysInfo = wx.getSystemInfoSync();
    const screenWidth = sysInfo.screenWidth || 375;
    const windowHeight = sysInfo.windowHeight || 667;
    const statusBarHeight = sysInfo.statusBarHeight || 20;
    const rpxToPx = screenWidth / 750;
    const headerHeight = (16 + 36 + 24) * rpxToPx;
    const scrollHeight = windowHeight - statusBarHeight - headerHeight;

    const recordId = opts.recordId || '';
    this.setData({ statusBarHeight, scrollHeight, recordId });
    this.loadDestiny(recordId);
  },

  onUnload() {
    this.clearAdTimer();
  },

  loadDestiny(recordId) {
    this.setData({ loading: true, errorMsg: '' });
    apiGetDestiny(recordId).then(data => {
      if (data && data.error) {
        this.setData({ loading: false, errorMsg: data.error, destiny: null });
      } else if (data && data.segments) {
        this.setData({ loading: false, destiny: data });
      } else {
        this.setData({ loading: false, errorMsg: '加载失败', destiny: null });
      }
    }).catch(() => {
      this.setData({ loading: false, errorMsg: '网络异常', destiny: null });
    });
  },

  onBackTap() {
    wx.navigateBack({ delta: 1 });
  },

  // 解锁单段
  onUnlockSegment(e) {
    const idx = e.currentTarget.dataset.index;
    const seg = this.data.destiny.segments[idx];
    if (!seg || !seg.locked) return;

    // 第 0 段免费，直接解锁
    if (idx === 0 || seg.unlockType === 'free') {
      this.doUnlock('single', 0);
      return;
    }

    // 其余段落看广告解锁
    this.startAd('single', idx);
  },

  // 一次解锁全部
  onUnlockBundle() {
    const d = this.data.destiny;
    if (!d || d.allUnlocked) return;
    this.startAd('bundle');
  },

  // ==================== 广告模拟 ====================
  startAd(mode, index) {
    const duration = (this.data.destiny && this.data.destiny.adDurationMs) || 15000;
    const totalSec = Math.max(5, Math.round(duration / 1000));
    this.clearAdTimer();
    this.setData({
      adVisible: true,
      adCountdown: totalSec,
      adReady: false,
      adMode: mode,
      adIndex: index === undefined ? -1 : index
    });

    this.adTimer = setInterval(() => {
      const next = this.data.adCountdown - 1;
      if (next > 0) {
        this.setData({ adCountdown: next, adReady: false });
      } else {
        this.clearAdTimer();
        this.setData({ adCountdown: 0, adReady: true });
      }
    }, 1000);
  },

  clearAdTimer() {
    if (this.adTimer) {
      clearInterval(this.adTimer);
      this.adTimer = null;
    }
  },

  // 关闭广告（未看完则取消解锁）
  onAdClose() {
    if (!this.data.adReady) {
      this.clearAdTimer();
      this.setData({ adVisible: false, adReady: false });
      wx.showToast({ title: '广告未看完', icon: 'none' });
      return;
    }
    // 看完 → 领取奖励 → 解锁
    this.clearAdTimer();
    this.setData({ adVisible: false, adReady: false });
    this.doUnlock(this.data.adMode, this.data.adIndex);
  },

  doUnlock(mode, index) {
    wx.showLoading({ title: '解锁中…', mask: true });
    apiUnlockDestiny(this.data.recordId, mode, index).then(res => {
      wx.hideLoading();
      if (res && res.ok) {
        wx.showToast({
          title: mode === 'bundle' ? '全部解锁' : '已解锁',
          icon: 'success'
        });
        this.loadDestiny(this.data.recordId);
      } else {
        wx.showToast({
          title: (res && res.error) || '解锁失败',
          icon: 'none'
        });
      }
    }).catch(() => {
      wx.hideLoading();
      wx.showToast({ title: '网络异常', icon: 'none' });
    });
  },

  onShareAppMessage() {
    const d = this.data.destiny;
    return {
      title: d ? `命运轨迹 · ${d.recordId}` : '赛博放生局 · 命运轨迹',
      path: `/pages/destiny/destiny?recordId=${this.data.recordId}`
    };
  }
});
