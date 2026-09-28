// 赛博放生 · 静态数据（v2）
// 旧 SIGNS / REPLY_POOL 随旧产品下线（历史代码见 legacy/story-v0/）。

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

module.exports = { CREATURES, WATERS, PLACEHOLDERS };
