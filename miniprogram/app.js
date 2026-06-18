// 赛博放生局小程序 · 应用入口
const { seedDemoData, checkPendingReplies } = require('./utils/storage.js');

App({
  onLaunch() {
    // 小程序启动时执行
    const sysInfo = wx.getSystemInfoSync();
    this.statusBarHeight = sysInfo.statusBarHeight || 20;
    this.screenWidth = sysInfo.screenWidth || 375;
    this.screenHeight = sysInfo.screenHeight || 667;

    // 初始化 demo 数据并检查到期回信
    seedDemoData();
    checkPendingReplies();
  },
  globalData: {
    userInfo: null,
    openid: 'demo_openid_3a7f',
    todayCount: 1247
  }
});
