// 赛博放生局 · 辅助函数

// 数字补零
function pad(n, len) {
  return String(n).padStart(len, '0');
}

// 数组随机取一项
function rand(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

// 短时间格式 MM.DD HH:mm
function formatTime(ts) {
  const d = new Date(ts);
  return pad(d.getMonth() + 1, 2) + '.' + pad(d.getDate(), 2) + ' ' +
         pad(d.getHours(), 2) + ':' + pad(d.getMinutes(), 2);
}

// 完整时间格式 YYYY.MM.DD HH:mm
function formatFullTime(ts) {
  const d = new Date(ts);
  return d.getFullYear() + '.' + pad(d.getMonth() + 1, 2) + '.' + pad(d.getDate(), 2) +
         ' ' + pad(d.getHours(), 2) + ':' + pad(d.getMinutes(), 2);
}

// 倒计时格式 HH:mm:ss
function formatCountdown(ms) {
  if (ms <= 0) return '00:00:00';
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  return pad(h, 2) + ':' + pad(m, 2) + ':' + pad(s, 2);
}

// 生成护生编号 CRSB-YYYYMMDD-XXXX
function generateId() {
  const d = new Date();
  const dateStr = d.getFullYear() + pad(d.getMonth() + 1, 2) + pad(d.getDate(), 2);
  const rand4 = pad(Math.floor(Math.random() * 9999), 4);
  return 'CRSB-' + dateStr + '-' + rand4;
}

// 数字千分位
function toLocaleString(n) {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

module.exports = {
  pad,
  rand,
  formatTime,
  formatFullTime,
  formatCountdown,
  generateId,
  toLocaleString
};
