// 赛博放生局 · 命运轨迹页
const { apiGetDestiny, apiUnlockDestiny } = require('../../utils/api.js');

Page({
  data: {
    statusBarHeight: 20,
    scrollHeight: 600,
    recordId: '',
    loading: true,
    destiny: null,
    errorMsg: ''
  },

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

  loadDestiny(recordId) {
    this.setData({ loading: true, errorMsg: '' });
    apiGetDestiny(recordId).then(data => {
      if (data && data.error) {
        this.setData({ loading: false, errorMsg: data.error, destiny: null });
      } else if (data && data.segments) {
        // 预格式化价格（分 → 元字符串）
        data.segments = data.segments.map(seg => ({
          ...seg,
          priceYuan: seg.price ? '¥' + (seg.price / 100).toFixed(0) : ''
        }));
        data.bundlePriceYuan = data.bundlePrice ? '¥' + (data.bundlePrice / 100).toFixed(0) : '';
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

    // 第 0 段免费，直接解锁；其余 mock 支付
    if (idx === 0) {
      this.doUnlock('single', 0);
      return;
    }

    wx.showModal({
      title: '解锁命运轨迹',
      content: `支付 ¥${(seg.price / 100).toFixed(0)} 解锁「${seg.title}」？`,
      confirmText: '支付',
      confirmColor: '#2c8a7a',
      success: (res) => {
        if (res.confirm) {
          this.doUnlock('single', idx);
        }
      }
    });
  },

  // 一次解锁全部
  onUnlockBundle() {
    const d = this.data.destiny;
    if (!d || d.allUnlocked) return;
    wx.showModal({
      title: '一次解锁全部',
      content: `支付 ¥${(d.bundlePrice / 100).toFixed(0)} 解锁全部 ${d.totalSegments} 段命运轨迹？`,
      confirmText: '支付',
      confirmColor: '#ed7d5b',
      success: (res) => {
        if (res.confirm) {
          this.doUnlock('bundle');
        }
      }
    });
  },

  doUnlock(mode, index) {
    wx.showLoading({ title: '支付中…', mask: true });
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
