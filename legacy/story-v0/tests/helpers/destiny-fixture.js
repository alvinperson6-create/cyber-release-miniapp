// 测试公共夹具：合法的四集命运轨迹 JSON
function makeDestinyJson({ textPrefix = '剧情', location = '西湖断桥' } = {}) {
  const seg = (t) => ({
    title: `标题${t}`,
    text: `${textPrefix}${t}：生物因为处境做出了具体行为，然后发生了事件，推动了下一集的走向，情节完整足够长。`,
    emoji: '🐟'
  });
  return {
    location,
    visualForImage: {
      style: '荒诞写实',
      subject: '锦鲤位于画面中心',
      action: '背着外卖箱狂游',
      place: `${location}附近`,
      bgElements: '外卖箱、路灯',
      mood: '荒诞搞笑'
    },
    segments: [seg(1), seg(2), seg(3), seg(4)]
  };
}

module.exports = { makeDestinyJson };
