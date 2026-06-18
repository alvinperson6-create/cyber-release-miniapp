// 赛博放生局 · 数据常量
// 所有常量与 web 版保持一致

// ==================== 生物 ====================
const CREATURES = {
  koi: { name: '电子锦鲤', emoji: '🐟' },
  turtle: { name: '电子乌龟', emoji: '🐢' },
  cloud: { name: '电子云朵', emoji: '☁️' }
};

// ==================== 水域 ====================
const WATERS = {
  pacific:   { name: '太平洋',         type: 'ocean'  },
  atlantic:  { name: '大西洋',         type: 'ocean'  },
  indian:    { name: '印度洋',         type: 'ocean'  },
  arctic:    { name: '北冰洋',         type: 'ocean'  },
  baikal:    { name: '贝加尔湖',       type: 'lake'   },
  ness:      { name: '尼斯湖',         type: 'lake'   },
  xihu:      { name: '西湖',           type: 'lake'   },
  xiang:     { name: '湘江',           type: 'river'  },
  mariana:   { name: '马里亚纳海沟',   type: 'trench' },
  deadsea:   { name: '死海',           type: 'lake'   },
  aegean:    { name: '爱琴海',         type: 'sea'    },
  galapagos: { name: '加拉帕戈斯',     type: 'sea'    }
};

// ==================== 水域坐标 (640×480 坐标系) ====================
const WATER_COORDS = {
  pacific:   { x: 590, y: 200 },
  atlantic:  { x: 225, y: 180 },
  indian:    { x: 460, y: 340 },
  arctic:    { x: 340, y: 25  },
  baikal:    { x: 450, y: 120 },
  ness:      { x: 295, y: 90  },
  xihu:      { x: 515, y: 155 },
  xiang:     { x: 505, y: 175 },
  mariana:   { x: 600, y: 275 },
  deadsea:   { x: 395, y: 198 },
  aegean:    { x: 350, y: 188 },
  galapagos: { x: 95,  y: 260 }
};

// ==================== 大陆形状 (近似 web 版 SVG 路径) ====================
// 每个大陆用 {x, y, w, h, r} 表示一个圆角矩形 (在 640×480 坐标系中)
const CONTINENTS = [
  // 北美洲 (path: 40-195, 50-195)
  { x: 40,  y: 50,  w: 160, h: 150, r: 80,  shape: 'ellipse' },
  // 南美洲 (path: 120-195, 220-370)
  { x: 120, y: 220, w: 75,  h: 155, r: 40,  shape: 'ellipse' },
  // 格陵兰 (path: 200-255, 30-75)
  { x: 200, y: 30,  w: 55,  h: 50,  r: 25,  shape: 'ellipse' },
  // 欧亚大陆 (path: 250-555, 55-195)
  { x: 250, y: 55,  w: 310, h: 145, r: 75,  shape: 'ellipse' },
  // 印度次大陆 (path: 283-308, 88-115)
  { x: 283, y: 88,  w: 25,  h: 30,  r: 12,  shape: 'ellipse' },
  // 日本 (path: 538-560, 125-155)
  { x: 538, y: 125, w: 22,  h: 32,  r: 11,  shape: 'ellipse' },
  // 非洲 (path: 320-405, 200-340)
  { x: 320, y: 200, w: 85,  h: 145, r: 45,  shape: 'ellipse' },
  // 东南亚岛屿 (path: 498-530, 215-245)
  { x: 498, y: 215, w: 32,  h: 30,  r: 15,  shape: 'ellipse' },
  // 澳大利亚 (path: 488-565, 325-392)
  { x: 488, y: 325, w: 78,  h: 70,  r: 35,  shape: 'ellipse' }
];

// ==================== 热门水域 ====================
const HOT_WATERS = ['pacific', 'baikal', 'mariana'];

// ==================== 生物 SVG (完整 svg 标签) ====================
// 从 web 版 CREATURE_SVG 的 <g> 内容包装成完整 <svg>
const CREATURE_SVG = {
  koi: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 80">
    <defs>
      <linearGradient id="koiGrad" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0%" stop-color="#f9d8c9"/>
        <stop offset="50%" stop-color="#ed7d5b"/>
        <stop offset="100%" stop-color="#d96d4d"/>
      </linearGradient>
    </defs>
    <g>
      <ellipse cx="60" cy="40" rx="38" ry="20" fill="url(#koiGrad)"/>
      <ellipse cx="60" cy="40" rx="38" ry="20" fill="none" stroke="#b85a3a" stroke-width="0.5" opacity="0.4"/>
      <path d="M22 40 Q 10 28 6 40 Q 10 52 22 40 Z" fill="#ed7d5b"/>
      <ellipse cx="60" cy="32" rx="14" ry="4" fill="#fff" opacity="0.5"/>
      <circle cx="78" cy="36" r="3" fill="#1f3a36"/>
      <circle cx="79" cy="35" r="0.8" fill="#fff"/>
      <path d="M55 50 Q 60 60 65 50" stroke="#b85a3a" stroke-width="1" fill="none" opacity="0.6"/>
    </g>
  </svg>`,
  turtle: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 80">
    <g>
      <ellipse cx="60" cy="50" rx="36" ry="22" fill="#3e7a96"/>
      <ellipse cx="60" cy="50" rx="36" ry="22" fill="none" stroke="#1f3a36" stroke-width="0.5" opacity="0.3"/>
      <ellipse cx="60" cy="50" rx="24" ry="14" fill="#5a9bb5"/>
      <g fill="#2c5d72" opacity="0.55">
        <ellipse cx="60" cy="42" rx="4" ry="3"/>
        <ellipse cx="48" cy="48" rx="4" ry="3"/>
        <ellipse cx="72" cy="48" rx="4" ry="3"/>
        <ellipse cx="54" cy="58" rx="4" ry="3"/>
        <ellipse cx="66" cy="58" rx="4" ry="3"/>
        <ellipse cx="60" cy="50" rx="3" ry="3"/>
      </g>
      <ellipse cx="22" cy="52" rx="10" ry="6" fill="#5a9bb5"/>
      <ellipse cx="98" cy="52" rx="10" ry="6" fill="#5a9bb5"/>
      <circle cx="22" cy="50" r="2" fill="#1f3a36"/>
      <circle cx="98" cy="50" r="2" fill="#1f3a36"/>
      <circle cx="22.6" cy="49.5" r="0.6" fill="#fff"/>
      <circle cx="98.6" cy="49.5" r="0.6" fill="#fff"/>
    </g>
  </svg>`,
  cloud: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 80">
    <g>
      <ellipse cx="60" cy="48" rx="42" ry="22" fill="#faf6ec"/>
      <ellipse cx="40" cy="42" rx="18" ry="16" fill="#faf6ec"/>
      <ellipse cx="78" cy="40" rx="20" ry="18" fill="#faf6ec"/>
      <ellipse cx="60" cy="38" rx="16" ry="14" fill="#fff"/>
      <ellipse cx="60" cy="48" rx="42" ry="22" fill="none" stroke="#c7dbe2" stroke-width="0.6"/>
      <g opacity="0.5">
        <circle cx="44" cy="42" r="2" fill="#cfe4dd"/>
        <circle cx="56" cy="40" r="2.5" fill="#cfe4dd"/>
        <circle cx="70" cy="38" r="2" fill="#cfe4dd"/>
        <circle cx="80" cy="44" r="2" fill="#cfe4dd"/>
      </g>
      <circle cx="48" cy="46" r="1.2" fill="#1f3a36"/>
      <circle cx="72" cy="46" r="1.2" fill="#1f3a36"/>
      <path d="M52 52 Q 60 56 68 52" stroke="#1f3a36" stroke-width="0.8" fill="none" opacity="0.6"/>
    </g>
  </svg>`
};

// 将 SVG 字符串转换为 data URI (供 image 组件使用)
function svgToDataUri(svg) {
  return 'data:image/svg+xml,' + encodeURIComponent(svg);
}

// 预生成生物 data URI
const CREATURE_DATA_URI = {
  koi: svgToDataUri(CREATURE_SVG.koi),
  turtle: svgToDataUri(CREATURE_SVG.turtle),
  cloud: svgToDataUri(CREATURE_SVG.cloud)
};

// ==================== 好运签 ====================
const SIGNS = {
  koi: [
    '今天的你已经比昨天更松弛一丢丢了。',
    '锦鲤说：好运不是等来的，是你走过去接的。',
    '你放下的东西，会以另一种形式回来。',
    '今天适合做一件没用但开心的事。',
    '紧张说明你在乎，在乎说明你认真。'
  ],
  turtle: [
    '乌龟说：慢一点也没关系，方向对就行。',
    '你不需要赢过谁，你只需要不放弃。',
    '今天的疲惫是明天的铠甲。',
    '允许自己偶尔停下来，这不叫偷懒。',
    '乌龟的壳不是逃避，是给自己一个安全的空间。'
  ],
  cloud: [
    '云朵说：飘着飘着，风就来了。',
    '你此刻的烦恼，90% 不会发生。',
    '允许自己不开心一会儿，但别忘了开心。',
    '天上没有过不去的云，地上没有过不去的坎。',
    '你比你以为的要轻，放下一些就飘起来了。'
  ]
};

// ==================== 回信池 ====================
const REPLY_POOL = [
  { bg: 'linear-gradient(135deg, #d4e8e2, #a9d2c5)', emoji: '🌿', text: '你放生的那只小家伙在电子水域里安顿下来了。它托我转告：你此刻觉得过不去的坎，三个月后回头看连坎都不算。深呼吸，没事的。' },
  { bg: 'linear-gradient(135deg, #c7dbe2, #9bc8bd)', emoji: '🌙', text: '今晚的水域很安静。你的感受已经被收到了——不是被解决了，是被听到了。有些事不需要解决，被听到就够了。' },
  { bg: 'linear-gradient(135deg, #f9d8c9, #ed7d5b)', emoji: '🔥', text: '好消息：你焦虑的事有 87% 不会发生。坏消息：剩下 13% 你也管不了。所以这只电子生物决定替你扛着，你先去吃顿好的。' },
  { bg: 'linear-gradient(135deg, #e8d5f0, #c4a8d8)', emoji: '✨', text: '它游了一圈回来说：你比自己以为的要结实。那些让你觉得要碎掉的时刻，其实你一次都没真碎过。这次也不会。' },
  { bg: 'linear-gradient(135deg, #fff3cd, #ffd970)', emoji: '☀️', text: '报告！你的电子生物已在虚拟水域完成打卡。它观察到：你最近对自己太严格了。建议本周至少做两件"没用但开心"的事。' },
  { bg: 'linear-gradient(135deg, #d1ecf1, #79c8d9)', emoji: '🌊', text: '水域温度 22°C，生物状态良好。它给你带了一句话："紧张说明你在乎，在乎说明你认真，认真的人运气不会太差。"' }
];

// ==================== 输入框占位符 (轮播) ====================
const PLACEHOLDERS = [
  '明天要答辩，紧张到胃疼...',
  '又加班到十一点，脑子嗡嗡的...',
  '就是莫名的烦躁，说不上来...',
  '项目明天上线，手心一直在出汗...',
  '凌晨三点了还是睡不着，想太多...',
  '今天被老板否了第三版方案...'
];

// ==================== 回信时间选项标签 ====================
const FB_LABELS = {
  '24h': '24 小时后',
  '3d': '3 天后',
  '7d': '7 天后',
  'custom': ''
};

// ==================== 地图缩放参数 ====================
// 原始坐标系 640×480, 地图内容尺寸 1400rpx × 1050rpx
const MAP_ORIGINAL = { w: 640, h: 480 };
const MAP_CONTENT = { w: 1400, h: 1050 };
const SCALE = MAP_CONTENT.w / MAP_ORIGINAL.w; // 2.1875

module.exports = {
  CREATURES,
  WATERS,
  WATER_COORDS,
  CONTINENTS,
  HOT_WATERS,
  CREATURE_SVG,
  CREATURE_DATA_URI,
  svgToDataUri,
  SIGNS,
  REPLY_POOL,
  PLACEHOLDERS,
  FB_LABELS,
  MAP_ORIGINAL,
  MAP_CONTENT,
  SCALE
};
