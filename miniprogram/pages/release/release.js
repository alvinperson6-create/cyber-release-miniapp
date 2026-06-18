// 赛博放生局 · 放生页
const app = getApp();
const {
  CREATURES, WATERS, WATER_COORDS, CONTINENTS, HOT_WATERS,
  CREATURE_DATA_URI, SIGNS, PLACEHOLDERS, FB_LABELS,
  MAP_ORIGINAL
} = require('../../utils/data.js');
const { apiRelease } = require('../../utils/api.js');
const { rand, pad, formatFullTime, generateId, toLocaleString } = require('../../utils/util.js');

// 地图原始坐标系
const MAP_W = MAP_ORIGINAL.w; // 640
const MAP_H = MAP_ORIGINAL.h; // 480

Page({
  data: {
    // 系统 & 布局
    statusBarHeight: 20,
    navTotalHeight: 64,
    canvasHeight: 300,
    panelHeight: 400,
    mapW: 600,
    mapH: 450,
    mapOffsetX: 0,
    mapOffsetY: 0,

    // 地图数据
    waterMarkers: [],
    continents: [],
    hotWaters: [],

    // 表单状态
    feeling: '',
    selectedCreature: null,
    selectedWater: null,
    selectedWaterName: '未选择',
    creatureImg: CREATURE_DATA_URI.koi,
    feedbackTime: '24h',
    customDate: '',
    todayStr: '',
    placeholder: PLACEHOLDERS[0],

    // 列表数据
    creatureList: [],
    feedbackOptions: [],

    // 交互状态
    isReleased: false,
    isRecording: false,
    ready: false,
    btnText: '选好啦 · 按下放生',
    todayCountStr: '1,247',

    // 回执
    showReceipt: false,
    receiptData: null
  },

  // 页面内部状态 (不参与渲染)
  touchStart: null,
  mapBounds: null,
  mapMoved: false,
  placeholderTimer: null,
  placeholderIdx: 0,

  onLoad() {
    const sysInfo = wx.getSystemInfoSync();
    const screenWidth = sysInfo.screenWidth || 375;
    const windowHeight = sysInfo.windowHeight || 667;
    const statusBarHeight = sysInfo.statusBarHeight || 20;
    const rpxToPx = screenWidth / 750;

    // 导航栏总高度 (状态栏 + 88rpx 导航内容)
    const navBarContentHeight = 88 * rpxToPx;
    const navTotalHeight = statusBarHeight + navBarContentHeight;

    // 可用高度 (窗口高度 - 导航栏)
    const availableHeight = windowHeight - navTotalHeight;

    // 水域画布占 42%, 控制面板占剩余
    const canvasHeight = Math.floor(availableHeight * 0.42);
    const panelHeight = availableHeight - canvasHeight;

    // 地图内容尺寸 (1.8 倍屏幕宽度, 保持 4:3 比例)
    const mapW = screenWidth * 1.8;
    const mapH = mapW * (MAP_H / MAP_W);

    // 初始偏移: 居中
    const mapOffsetX = (screenWidth - mapW) / 2;
    const mapOffsetY = (canvasHeight - mapH) / 2;

    // 地图拖动边界
    this.mapBounds = {
      minX: screenWidth - mapW,
      maxX: 0,
      minY: canvasHeight - mapH,
      maxY: 0
    };

    // 预计算水域标记点 (百分比定位)
    const waterMarkers = Object.keys(WATER_COORDS).map(key => {
      const coord = WATER_COORDS[key];
      const water = WATERS[key];
      return {
        key,
        name: water.name,
        typeClass: water.type,
        left: (coord.x / MAP_W * 100).toFixed(2),
        top: (coord.y / MAP_H * 100).toFixed(2)
      };
    });

    // 预计算大陆位置 (百分比定位)
    const continents = CONTINENTS.map(c => ({
      left: (c.x / MAP_W * 100).toFixed(2),
      top: (c.y / MAP_H * 100).toFixed(2),
      width: (c.w / MAP_W * 100).toFixed(2),
      height: (c.h / MAP_H * 100).toFixed(2)
    }));

    // 热门水域
    const hotWaters = HOT_WATERS.map(key => ({
      key,
      name: WATERS[key].name
    }));

    // 生物列表
    const creatureList = Object.keys(CREATURES).map(key => ({
      key,
      name: CREATURES[key].name,
      emoji: CREATURES[key].emoji
    }));

    // 回信时间选项
    const feedbackOptions = [
      { key: '24h', label: '24 小时后' },
      { key: '3d', label: '3 天后' },
      { key: '7d', label: '7 天后' },
      { key: 'custom', label: '自选时间' }
    ];

    // 今日日期字符串 (用于 date picker 的 start)
    const today = new Date();
    const todayStr = today.getFullYear() + '-' + pad(today.getMonth() + 1, 2) + '-' + pad(today.getDate(), 2);

    // 今日放生数
    const todayCountStr = toLocaleString(app.globalData.todayCount);

    this.setData({
      statusBarHeight,
      navTotalHeight,
      canvasHeight,
      panelHeight,
      mapW,
      mapH,
      mapOffsetX,
      mapOffsetY,
      waterMarkers,
      continents,
      hotWaters,
      creatureList,
      feedbackOptions,
      todayStr,
      todayCountStr
    });
  },

  onShow() {
    // 启动 placeholder 轮播
    this.startPlaceholderRotation();
  },

  onHide() {
    this.stopPlaceholderRotation();
  },

  onUnload() {
    this.stopPlaceholderRotation();
  },

  // ==================== Placeholder 轮播 ====================
  startPlaceholderRotation() {
    this.stopPlaceholderRotation();
    this.placeholderTimer = setInterval(() => {
      if (this.data.isReleased) return;
      // textarea 未聚焦时才轮播 (通过 data 标记)
      if (!this._textareaFocused) {
        this.placeholderIdx = (this.placeholderIdx + 1) % PLACEHOLDERS.length;
        this.setData({ placeholder: PLACEHOLDERS[this.placeholderIdx] });
      }
    }, 3500);
  },

  stopPlaceholderRotation() {
    if (this.placeholderTimer) {
      clearInterval(this.placeholderTimer);
      this.placeholderTimer = null;
    }
  },

  // ==================== 地图拖动 ====================
  onMapTouchStart(e) {
    if (this.data.isReleased) return;
    const touch = e.touches[0];
    this.touchStart = {
      x: touch.clientX,
      y: touch.clientY,
      offsetX: this.data.mapOffsetX,
      offsetY: this.data.mapOffsetY,
      moved: false
    };
  },

  onMapTouchMove(e) {
    if (!this.touchStart || this.data.isReleased) return;
    const touch = e.touches[0];
    const dx = touch.clientX - this.touchStart.x;
    const dy = touch.clientY - this.touchStart.y;

    if (Math.abs(dx) > 4 || Math.abs(dy) > 4) {
      this.touchStart.moved = true;
    }

    let newX = this.touchStart.offsetX + dx;
    let newY = this.touchStart.offsetY + dy;

    // 边界约束
    const b = this.mapBounds;
    newX = Math.max(b.minX, Math.min(b.maxX, newX));
    newY = Math.max(b.minY, Math.min(b.maxY, newY));

    this.setData({ mapOffsetX: newX, mapOffsetY: newY });
  },

  onMapTouchEnd() {
    if (!this.touchStart) return;
    this.mapMoved = this.touchStart.moved;
    this.touchStart = null;
    // 短暂保留 moved 状态供水域点击判断
    setTimeout(() => { this.mapMoved = false; }, 100);
  },

  // ==================== 水域选择 ====================
  onWaterTap(e) {
    if (this.mapMoved || this.data.isReleased) return;
    const water = e.currentTarget.dataset.water;
    this.selectWater(water);
  },

  onHotBubbleTap(e) {
    if (this.data.isReleased) return;
    const water = e.currentTarget.dataset.water;
    // 平移地图到该水域
    this.panToWater(water);
    this.selectWater(water);
  },

  selectWater(waterKey) {
    const waterName = WATERS[waterKey] ? WATERS[waterKey].name : '未选择';
    this.setData({
      selectedWater: waterKey,
      selectedWaterName: waterName
    });
    this.updateButtonState();
  },

  // 平移地图使指定水域居中
  panToWater(waterKey) {
    const coord = WATER_COORDS[waterKey];
    if (!coord) return;
    // 水域在地图内容中的像素位置
    const targetX = (coord.x / MAP_W) * this.data.mapW;
    const targetY = (coord.y / MAP_H) * this.data.mapH;
    // 居中所需偏移
    const sysInfo = wx.getSystemInfoSync();
    const screenWidth = sysInfo.screenWidth || 375;
    let newX = screenWidth / 2 - targetX;
    let newY = this.data.canvasHeight / 2 - targetY;
    // 边界约束
    const b = this.mapBounds;
    newX = Math.max(b.minX, Math.min(b.maxX, newX));
    newY = Math.max(b.minY, Math.min(b.maxY, newY));
    this.setData({ mapOffsetX: newX, mapOffsetY: newY });
  },

  // ==================== 感受输入 ====================
  onFeelingInput(e) {
    this.setData({ feeling: e.detail.value });
    this.updateButtonState();
  },

  onFeelingFocus() {
    this._textareaFocused = true;
  },

  onFeelingBlur() {
    this._textareaFocused = false;
  },

  // ==================== 生物选择 ====================
  onCreatureTap(e) {
    if (this.data.isReleased) return;
    const creature = e.currentTarget.dataset.creature;
    this.setData({
      selectedCreature: creature,
      creatureImg: CREATURE_DATA_URI[creature]
    });
    this.updateButtonState();
  },

  // ==================== 回信时间 ====================
  onFeedbackTap(e) {
    if (this.data.isReleased) return;
    const fb = e.currentTarget.dataset.fb;
    const update = { feedbackTime: fb };
    if (fb !== 'custom') {
      update.customDate = '';
    }
    this.setData(update);
  },

  onDateChange(e) {
    this.setData({ customDate: e.detail.value });
  },

  // ==================== 语音按钮 ====================
  onMicTap() {
    if (this.data.isReleased) return;
    wx.showToast({
      title: '语音功能开发中\n请先用文字输入',
      icon: 'none',
      duration: 2000
    });
  },

  // ==================== 按钮状态 ====================
  updateButtonState() {
    const ready = !!(this.data.feeling.trim() && this.data.selectedCreature && this.data.selectedWater && !this.data.isReleased);
    const btnText = this.data.isReleased ? '正在放生…' : (ready ? '按下放生' : '选好啦 · 按下放生');
    this.setData({ ready, btnText });
  },

  // ==================== 放生触发 ====================
  onReleaseTap() {
    if (!this.data.ready || this.data.isReleased) return;

    this.setData({ isReleased: true });
    this.updateButtonState();

    // 800ms 后显示回执 (等待生物下沉动画)
    setTimeout(() => {
      this.showReceipt();
    }, 800);
  },

  showReceipt() {
    const id = generateId();
    const sign = rand(SIGNS[this.data.selectedCreature]);
    const fbLabel = this.getFeedbackLabel();
    const replyAt = this.calcReplyAt();
    const now = Date.now();

    // 构造回执数据
    const receiptData = {
      id,
      waterName: WATERS[this.data.selectedWater].name,
      creatureEmoji: CREATURES[this.data.selectedCreature].emoji,
      creatureName: CREATURES[this.data.selectedCreature].name,
      timeStr: formatFullTime(now),
      feeling: this.data.feeling,
      sign,
      feedbackLabel: fbLabel
    };

    // 构造记录数据
    const recordData = {
      id,
      creature: this.data.selectedCreature,
      water: this.data.selectedWater,
      feeling: this.data.feeling,
      feedbackLabel: fbLabel,
      createdAt: now,
      replyAt,
      reply: null
    };

    // 保存记录 (API 带本地降级)
    apiRelease(recordData);

    // 更新今日放生数
    app.globalData.todayCount++;
    const todayCountStr = toLocaleString(app.globalData.todayCount);

    this.setData({
      showReceipt: true,
      receiptData,
      todayCountStr
    });
  },

  onReceiptClose() {
    this.setData({ showReceipt: false });
    // 重置表单
    setTimeout(() => {
      this.setData({
        isReleased: false,
        selectedCreature: null,
        selectedWater: null,
        selectedWaterName: '未选择',
        feeling: '',
        feedbackTime: '24h',
        customDate: '',
        creatureImg: CREATURE_DATA_URI.koi,
        receiptData: null
      });
      // 重置地图到居中
      const sysInfo = wx.getSystemInfoSync();
      const screenWidth = sysInfo.screenWidth || 375;
      const mapOffsetX = (screenWidth - this.data.mapW) / 2;
      const mapOffsetY = (this.data.canvasHeight - this.data.mapH) / 2;
      this.setData({ mapOffsetX, mapOffsetY });
      this.updateButtonState();
    }, 300);
  },

  // ==================== 辅助函数 ====================
  getFeedbackLabel() {
    if (this.data.feedbackTime === 'custom' && this.data.customDate) {
      return this.data.customDate.replace(/-/g, '.');
    }
    return FB_LABELS[this.data.feedbackTime] || '24 小时后';
  },

  calcReplyAt() {
    const now = Date.now();
    if (this.data.feedbackTime === '3d') return now + 3 * 24 * 3600 * 1000;
    if (this.data.feedbackTime === '7d') return now + 7 * 24 * 3600 * 1000;
    if (this.data.feedbackTime === 'custom' && this.data.customDate) {
      const t = new Date(this.data.customDate + 'T12:00:00').getTime();
      if (!isNaN(t)) return t;
    }
    return now + 24 * 3600 * 1000;
  },

  // ==================== 分享 ====================
  onShareAppMessage() {
    return {
      title: '赛博放生局 · 放一只电子生物到虚拟水域',
      path: '/pages/release/release'
    };
  }
});
