// 3D 地球共享配置 —— 三端唯一数据源
// 修改后运行 `node scripts/sync-globe-config.js` 同步生成 server/public/globe-config.json

// 12 个水域的真实经纬度（approx），用于映射到 3D 球面
const WATERS_GEO = {
  pacific:   { name: '太平洋',       type: 'ocean',  lat: 0,    lng: -160 },
  atlantic:  { name: '大西洋',       type: 'ocean',  lat: 15,   lng: -40 },
  indian:    { name: '印度洋',       type: 'ocean',  lat: -25,  lng: 75 },
  arctic:    { name: '北冰洋',       type: 'ocean',  lat: 85,   lng: 0 },
  aegean:    { name: '爱琴海',       type: 'ocean',  lat: 38,   lng: 25 },
  galapagos: { name: '加拉帕戈斯',   type: 'ocean',  lat: -0.7, lng: -90.5 },
  baikal:    { name: '贝加尔湖',     type: 'lake',   lat: 53.5, lng: 108 },
  ness:      { name: '尼斯湖',       type: 'lake',   lat: 57.3, lng: -4.4 },
  xihu:      { name: '西湖',         type: 'lake',   lat: 30.2, lng: 120.1 },
  deadsea:   { name: '死海',         type: 'lake',   lat: 31.5, lng: 35.5 },
  xiang:     { name: '湘江',         type: 'river',  lat: 28,   lng: 113 },
  mariana:   { name: '马里亚纳海沟', type: 'trench', lat: 11.3, lng: 142.2 }
};

// 生物 3D 风格参数（颜色与发光），三端保持一致的品牌色
const CREATURE_3D = {
  koi:    { color: 0xed7d5b, glow: 0xffb38a, name: '锦鲤' },
  turtle: { color: 0x7fb6a4, glow: 0xa9d2c5, name: '乌龟' },
  cloud:  { color: 0xf0e6d0, glow: 0xffffff, name: '云朵' }
};

// 动画时序常量（毫秒）
const GLOBE_ANIM = {
  CHARGE_MIN_MS: 600,       // 长按蓄力最短触发时间
  DIVE_MS: 1600,            // 生物俯冲入水时长
  RIPPLE_MS: 2400,          // 涟漪扩散时长
  BUBBLE_COUNT: 40,         // 入水气泡数量
  FOCUS_MS: 900,            // 选水域时球体对准的插值时长
  AUTO_ROTATE_SPEED: 0.0004 // 待机自转速度 rad/ms
};

// 经纬度 → 球面坐标（半径 r）
function latLngToVector3(lat, lng, r) {
  const phi = (90 - lat) * Math.PI / 180;
  const theta = (lng + 180) * Math.PI / 180;
  return {
    x: -r * Math.sin(phi) * Math.cos(theta),
    y: r * Math.cos(phi),
    z: r * Math.sin(phi) * Math.sin(theta)
  };
}

module.exports = { WATERS_GEO, CREATURE_3D, GLOBE_ANIM, latLngToVector3 };
