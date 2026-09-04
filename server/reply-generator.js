// 赛博放生 · 回信生成器
// 封装命运轨迹 + 回信文本 + 配图生成的完整链路，供调度器和放生接口复用

const {
  generateReplyImage,
  generateDestiny,
  summarizeDestiny,
  pickReplyVisual,
  templateReplyText
} = require('./ai');
const { insertDestiny, getDestinyByRecordId, updateReply, markReplyGenerating, clearReplyGenerating } = require('./db');

const PRE_GENERATE_MS = 10 * 60 * 1000; // 提前 10 分钟开始生成

function getReplyTimeLabel(ms) {
  if (ms == null) return '一天后';
  const minutes = Math.round(ms / (60 * 1000));
  if (minutes < 10) return '片刻后';
  if (minutes < 60) return `${minutes} 分钟后`;
  const hours = Math.round(ms / (60 * 60 * 1000));
  if (hours < 24) return `${hours} 小时后`;
  if (hours === 24) return '一天后';
  return `${Math.round(hours / 24)} 天后`;
}

function shouldGenerateNow(record, preGenerateMs = PRE_GENERATE_MS) {
  return record.reply_at - Date.now() <= preGenerateMs;
}

async function generateReplyForRecord(record) {
  markReplyGenerating(record.id);
  try {
    // 1. 先生成命运轨迹（决定地点、画面、离谱结局）
    let destiny = getDestinyByRecordId(record.id);
    if (!destiny) {
      const generated = await generateDestiny({
        feeling: record.feeling,
        creature: record.creature,
        water: record.water,
        replyTimeLabel: getReplyTimeLabel(record.reply_at - record.created_at)
      });
      insertDestiny({
        id: `DST-${record.id}`,
        recordId: record.id,
        openid: record.openid,
        segments: generated.segments,
        location: generated.location,
        visual: generated.visual,
        visualForImage: generated.visualForImage,
        reply: generated.reply,
        ending: generated.ending
      });
      destiny = getDestinyByRecordId(record.id);
    }
    const destinySummary = summarizeDestiny(destiny);

    // 2. 回信直接用命运轨迹里的 reply 字段，再生成配图
    const style = pickReplyVisual(record.creature);
    const reply = {
      bg: style.bg,
      emoji: style.emoji,
      text: destinySummary.reply || templateReplyText(record.feeling, record.creature, record.water, destinySummary)
    };
    const image = await generateReplyImage({
      feeling: record.feeling,
      creature: record.creature,
      water: record.water,
      destinySummary,
      replyText: reply.text
    });
    updateReply(record.id, { ...reply, image });
    return { ...reply, image };
  } finally {
    clearReplyGenerating(record.id);
  }
}

module.exports = {
  PRE_GENERATE_MS,
  getReplyTimeLabel,
  shouldGenerateNow,
  generateReplyForRecord
};
