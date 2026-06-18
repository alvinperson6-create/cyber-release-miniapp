const { CREATURES, WATERS, WATER_LIST, HOT_WATERS, SIGNS, PLACEHOLDERS, FB_OPTIONS } = require('../../utils/data');
const { addRecord } = require('../../utils/storage');

Page({
  data: {
    feeling: '',
    creature: null,
    water: null,
    feedbackTime: '24h',
    feedbackDate: '',
    showCustomPicker: false,
    isReleased: false,
    showReceipt: false,
    canRelease: false,
    placeholder: '',
    // Receipt data
    receipt: null,
    // Constants for rendering
    creatures: [
      { key: 'koi', label: '🐟 电子锦鲤' },
      { key: 'turtle', label: '🐢 电子乌龟' },
      { key: 'cloud', label: '☁️ 电子云朵' }
    ],
    waterList: WATER_LIST,
    hotWaters: HOT_WATERS.map(id => ({ id, name: WATERS[id].name })),
    fbOptions: FB_OPTIONS,
    selectedWaterName: '未选择',
    todayCount: 1247,
    creatureEmoji: '🐟',
    creatureReleased: false
  },

  phIdx: 0,
  phTimer: null,

  onLoad() {
    this.rotatePlaceholder();
    this.phTimer = setInterval(() => {
      this.phIdx = (this.phIdx + 1) % PLACEHOLDERS.length;
      this.rotatePlaceholder();
    }, 3500);
  },

  onUnload() {
    if (this.phTimer) clearInterval(this.phTimer);
  },

  rotatePlaceholder() {
    this.setData({ placeholder: PLACEHOLDERS[this.phIdx] });
  },

  // Feeling input
  onFeelingInput(e) {
    this.setData({ feeling: e.detail.value }, () => this.updateCta());
  },

  // Voice input (demo: just focus textarea)
  onMicTap() {
    wx.showToast({ title: 'Demo 模式：请直接输入', icon: 'none', duration: 1500 });
  },

  // Creature selection
  onCreatureTap(e) {
    if (this.data.isReleased) return;
    const key = e.currentTarget.dataset.key;
    this.setData({
      creature: key,
      creatureEmoji: CREATURES[key].emoji
    }, () => this.updateCta());
  },

  // Water selection
  onWaterTap(e) {
    if (this.data.isReleased) return;
    const id = e.currentTarget.dataset.id;
    this.setData({
      water: id,
      selectedWaterName: WATERS[id].name
    }, () => this.updateCta());
  },

  // Hot water quick select
  onHotWaterTap(e) {
    const id = e.currentTarget.dataset.id;
    this.setData({
      water: id,
      selectedWaterName: WATERS[id].name
    }, () => this.updateCta());
  },

  // Feedback time
  onFbTap(e) {
    if (this.data.isReleased) return;
    const val = e.currentTarget.dataset.value;
    this.setData({
      feedbackTime: val,
      showCustomPicker: val === 'custom'
    });
  },

  onDateChange(e) {
    this.setData({ feedbackDate: e.detail.value });
  },

  // Update CTA button
  updateCta() {
    const can = this.data.feeling.trim() && this.data.creature && this.data.water && !this.data.isReleased;
    this.setData({ canRelease: !!can });
  },

  // Get feedback label
  getFeedbackLabel() {
    const opt = FB_OPTIONS.find(o => o.value === this.data.feedbackTime);
    if (this.data.feedbackTime === 'custom' && this.data.feedbackDate) {
      return this.data.feedbackDate.replace(/-/g, '.').replace('T', ' ');
    }
    return opt ? opt.label : '24 小时后';
  },

  // Get reply timestamp
  getReplyAt() {
    const now = Date.now();
    const opt = FB_OPTIONS.find(o => o.value === this.data.feedbackTime);
    if (this.data.feedbackTime === 'custom' && this.data.feedbackDate) {
      const d = new Date(this.data.feedbackDate);
      return isNaN(d) ? now + 24 * 3600 * 1000 : d.getTime();
    }
    return now + (opt ? opt.ms : 24 * 3600 * 1000);
  },

  // Format time
  formatTime(ts) {
    const d = new Date(ts);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}.${p(d.getMonth()+1)}.${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  },

  // Pad number
  pad(n, len) {
    return String(n).padStart(len, '0');
  },

  // Random pick
  rand(arr) {
    return arr[Math.floor(Math.random() * arr.length)];
  },

  // Release!
  onReleaseTap() {
    if (!this.data.feeling.trim() || !this.data.creature || !this.data.water) return;

    this.setData({ isReleased: true, creatureReleased: true });

    // Generate receipt after animation
    setTimeout(() => {
      this.showReceipt();
    }, 800);
  },

  showReceipt() {
    const now = Date.now();
    const num = `CRSB-${new Date().toISOString().slice(0,10).replace(/-/g,'')}-${this.pad(Math.floor(Math.random()*9999), 4)}`;
    const fbLabel = this.getFeedbackLabel();
    const replyAt = this.getReplyAt();

    const receipt = {
      num,
      location: WATERS[this.data.water].name,
      creature: CREATURES[this.data.creature].name,
      time: this.formatTime(now),
      sign: this.rand(SIGNS[this.data.creature]),
      feeling: this.data.feeling,
      fbLabel
    };

    // Save to storage
    addRecord({
      id: num,
      creature: this.data.creature,
      water: this.data.water,
      feeling: this.data.feeling,
      feedbackLabel: fbLabel,
      createdAt: now,
      replyAt: replyAt,
      reply: null
    });

    this.setData({ receipt, showReceipt: true });
  },

  // Share
  onShareTap() {
    wx.showToast({ title: '已生成卡片', icon: 'success', duration: 1500 });
  },

  // Again
  onAgainTap() {
    this.setData({
      isReleased: false,
      creature: null,
      water: null,
      feeling: '',
      feedbackTime: '24h',
      feedbackDate: '',
      showCustomPicker: false,
      showReceipt: false,
      canRelease: false,
      selectedWaterName: '未选择',
      creatureEmoji: '🐟',
      creatureReleased: false,
      receipt: null
    });
  },

  onShareAppMessage() {
    return {
      title: '我在赛博放生局放了一只电子生物 🐟',
      path: '/pages/release/release'
    };
  }
});
