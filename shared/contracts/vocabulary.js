// 赛博放生 · 公开契约：共享静态词表（纯数据）
//
// 浏览器（生物/水域选择器、默认值）与服务端（校验、视图投影）共用同一份，
// 避免两边各维护一份导致漂移。
//
// 边界规则（阶段 3.1）：本文件只含纯数据，不得引入 IO / env / 密钥 / 副作用。

const CREATURES = {
  koi: { name: '锦鲤', emoji: '🐟' },
  turtle: { name: '乌龟', emoji: '🐢' },
  cloud: { name: '云朵', emoji: '☁️' }
};

const WATERS = {
  pacific: { name: '太平洋', type: 'ocean' },
  atlantic: { name: '大西洋', type: 'ocean' },
  indian: { name: '印度洋', type: 'ocean' },
  arctic: { name: '北冰洋', type: 'ocean' },
  baikal: { name: '贝加尔湖', type: 'lake' },
  ness: { name: '尼斯湖', type: 'lake' },
  xihu: { name: '西湖', type: 'lake' },
  xiang: { name: '湘江', type: 'river' },
  mariana: { name: '马里亚纳海沟', type: 'trench' },
  deadsea: { name: '死海', type: 'lake' },
  aegean: { name: '爱琴海', type: 'ocean' },
  galapagos: { name: '加拉帕戈斯', type: 'ocean' }
};

const PLACEHOLDERS = [
  '明天要答辩，紧张到胃疼...',
  '又加班到十一点，脑子嗡嗡的...',
  '就是莫名的烦躁，说不上来...',
  '项目明天上线，手心一直在出汗...',
  '凌晨三点了还是睡不着，想太多...',
  '谁找我帮忙我都答应，最后只有我的事没做完...'
];

/** 生物/水域的可选值（契约校验用，避免服务端散落硬编码字符串） */
const CREATURE_IDS = Object.keys(CREATURES);
const WATER_IDS = Object.keys(WATERS);

function creatureName(species) {
  return CREATURES[species]?.name || species;
}

function creatureEmoji(species) {
  return CREATURES[species]?.emoji || '🐚';
}

function waterName(water) {
  return WATERS[water]?.name || water;
}

function waterType(water) {
  return WATERS[water]?.type || '水域';
}

module.exports = {
  CREATURES, WATERS, PLACEHOLDERS,
  CREATURE_IDS, WATER_IDS,
  creatureName, creatureEmoji, waterName, waterType
};
