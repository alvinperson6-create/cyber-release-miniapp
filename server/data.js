const CREATURES = {
  koi: { name: '电子锦鲤', emoji: '🐟' },
  turtle: { name: '电子乌龟', emoji: '🐢' },
  cloud: { name: '电子云朵', emoji: '☁️' }
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

const SIGNS = {
  koi: ['今天的你已经比昨天更松弛一丢丢了。', '锦鲤说：好运不是等来的，是你走过去接的。', '你放下的东西，会以另一种形式回来。', '今天适合做一件没用但开心的事。', '紧张说明你在乎，在乎说明你认真。'],
  turtle: ['乌龟说：慢一点也没关系，方向对就行。', '你不需要赢过谁，你只需要不放弃。', '今天的疲惫是明天的铠甲。', '允许自己偶尔停下来，这不叫偷懒。', '乌龟的壳不是逃避，是给自己一个安全的空间。'],
  cloud: ['云朵说：飘着飘着，风就来了。', '你此刻的烦恼，90% 不会发生。', '允许自己不开心一会儿，但别忘了开心。', '天上没有过去的云，地上没有过去的坎。', '你比你以为的要轻，放下一些就飘起来了。']
};

const REPLY_POOL = [
  { bg: 'linear-gradient(135deg, #d4e8e2, #a9d2c5)', emoji: '🌿', text: '你放生的那只小家伙在电子水域里安顿下来了。它托我转告：你此刻觉得过不去的坎，三个月后回头看连坎都不算。深呼吸，没事的。' },
  { bg: 'linear-gradient(135deg, #c7dbe2, #9bc8bd)', emoji: '🌙', text: '今晚的水域很安静。你的感受已经被收到了——不是被解决了，是被听到了。有些事不需要解决，被听到就够了。' },
  { bg: 'linear-gradient(135deg, #f9d8c9, #ed7d5b)', emoji: '🔥', text: '好消息：你焦虑的事有 87% 不会发生。坏消息：剩下 13% 你也管不了。所以这只电子生物决定替你扛着，你先去吃顿好的。' },
  { bg: 'linear-gradient(135deg, #e8d5f0, #c4a8d8)', emoji: '✨', text: '它游了一圈回来说：你比自己以为的要结实。那些让你觉得要碎掉的时刻，其实你一次都没真碎过。这次也不会。' },
  { bg: 'linear-gradient(135deg, #fff3cd, #ffd970)', emoji: '☀️', text: '报告！你的电子生物已在虚拟水域完成打卡。它观察到：你最近对自己太严格了。建议本周至少做两件"没用但开心"的事。' },
  { bg: 'linear-gradient(135deg, #d1ecf1, #79c8d9)', emoji: '🌊', text: '水域温度 22°C，生物状态良好。它给你带了一句话："紧张说明你在乎，在乎说明你认真，认真的人运气不会太差。"' }
];

const PLACEHOLDERS = [
  '明天要答辩，紧张到胃疼...',
  '又加班到十一点，脑子嗡嗡的...',
  '就是莫名的烦躁，说不上来...',
  '项目明天上线，手心一直在出汗...',
  '凌晨三点了还是睡不着，想太多...',
  '今天被老板否了第三版方案...'
];

module.exports = { CREATURES, WATERS, SIGNS, REPLY_POOL, PLACEHOLDERS };
