const { CREATURES, WATERS } = require('../../utils/data');
const { getRecords, getStats, checkPendingReplies } = require('../../utils/storage');

Page({
  data: {
    records: [],
    stats: { total: 0, pending: 0, replied: 0 },
    userId: '3a7f',
    expandedIds: {}  // track which items are expanded
  },

  timer: null,

  onShow() {
    this.loadData();
    // Start countdown timer
    this.timer = setInterval(() => {
      this.updateCountdowns();
    }, 1000);
  },

  onHide() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  },

  onUnload() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  },

  loadData() {
    // Check for pending replies that are due
    checkPendingReplies();

    const records = getRecords();
    const stats = getStats();

    // Format records for display
    const formatted = records.map(r => ({
      ...r,
      creatureName: CREATURES[r.creature]?.name || '',
      creatureEmoji: CREATURES[r.creature]?.emoji || '🐟',
      waterName: WATERS[r.water]?.name || r.water,
      timeStr: this.formatTime(r.createdAt),
      hasReply: !!r.reply,
      countdown: r.reply ? '' : this.formatCountdown(r.replyAt - Date.now()),
      expanded: false
    }));

    this.setData({ records: formatted, stats });
  },

  formatTime(ts) {
    const d = new Date(ts);
    const p = (n) => String(n).padStart(2, '0');
    return `${p(d.getMonth()+1)}.${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  },

  formatCountdown(ms) {
    if (ms <= 0) return '00:00:00';
    const h = Math.floor(ms / 3600000);
    const m = Math.floor((ms % 3600000) / 60000);
    const s = Math.floor((ms % 60000) / 1000);
    const p = (n) => String(n).padStart(2, '0');
    return `${p(h)}:${p(m)}:${p(s)}`;
  },

  updateCountdowns() {
    const records = this.data.records;
    let changed = false;
    let needsReload = false;

    const updated = records.map(r => {
      if (r.hasReply) return r;
      const remaining = r.replyAt - Date.now();
      if (remaining <= 0) {
        needsReload = true;
        return r;
      }
      changed = true;
      return { ...r, countdown: this.formatCountdown(remaining) };
    });

    if (needsReload) {
      this.loadData();
      return;
    }
    if (changed) {
      this.setData({ records: updated });
    }
  },

  onItemTap(e) {
    const idx = e.currentTarget.dataset.idx;
    const records = this.data.records;
    const record = records[idx];
    if (!record || !record.hasReply) return;

    // Toggle expanded
    const updated = records.map((r, i) => {
      if (i === idx) return { ...r, expanded: !r.expanded };
      return r;
    });
    this.setData({ records: updated });
  }
});
