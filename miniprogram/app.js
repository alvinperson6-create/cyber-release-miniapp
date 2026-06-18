// app.js
App({
  onLaunch() {
    // 静默登录（demo 模式：仅生成模拟 openid）
    const openid = wx.getStorageSync('mock_openid');
    if (!openid) {
      const mockId = 'demo_' + Math.random().toString(36).slice(2, 10);
      wx.setStorageSync('mock_openid', mockId);
    }

    // 首次访问注入 demo 数据
    const records = wx.getStorageSync('records');
    if (!records || records.length === 0) {
      const { seedDemoData } = require('./utils/storage');
      seedDemoData();
    }
  },

  globalData: {
    openid: ''
  }
});
