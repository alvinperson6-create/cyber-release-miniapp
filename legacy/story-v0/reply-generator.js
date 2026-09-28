// 赛博放生 · 回信生成器
// 封装「故事编排 → 落库冻结 → 派生回信 → 配图生成」的完整链路。
// 调度器（index.js）与 HTTP 入口（routes/reply.js /generate）都必须走这里，
// 保证两条入口复用同一核心编排（handoff §4.3/§10）。

const {
  generateReplyImage,
  summarizeDestiny,
  pickReplyVisual,
  templateReplyText
} = require('./ai');
const db = require('./db');
const { createStoryForRecord } = require('./story-pipeline');
const { journeyEnabled } = require('./flags');

const PRE_GENERATE_MS = 10 * 60 * 1000; // 提前 10 分钟开始生成

// 进程内互斥：同一记录的生成并发去重（调度器与 HTTP 入口同进程竞态时只跑一次）
const inflight = new Map();

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

/**
 * 统一核心：确保记录有已冻结的故事版本，并派生回信与配图。
 * - 故事已存在（含旧数据）→ 直接复用，不重新生成、不重置解锁
 * - 回信已写、仅缺图 → 只补图，不重写故事
 * - 新故事经 story-pipeline 编排（处境判断→契约→生成→验收→修复/降级）
 */
async function ensureStoryAndReply(record) {
  // 并发去重：同记录的第二次调用等待第一次的结果
  if (inflight.has(record.id)) {
    return inflight.get(record.id);
  }
  const job = (async () => {
    db.markReplyGenerating(record.id);
    try {
      // 1. 已回信的记录：故事与回信都已冻结，最多补图
      if (record.reply_text) {
        if (record.reply_image) {
          return { bg: record.reply_bg, emoji: record.reply_emoji, text: record.reply_text, image: record.reply_image };
        }
        const destiny = db.getDestinyByRecordId(record.id);
        const destinySummary = destiny ? summarizeDestiny(destiny) : null;
        const image = await generateReplyImage({
          feeling: record.feeling,
          creature: record.creature,
          water: record.water,
          destinySummary,
          replyText: record.reply_text
        });
        const reply = { bg: record.reply_bg, emoji: record.reply_emoji, text: record.reply_text, image };
        if (image) db.updateReply(record.id, reply);
        return reply;
      }

      // 2. 已有故事（旧数据或此前已生成）→ 冻结版本直接复用
      let destiny = db.getDestinyByRecordId(record.id);
      let storyMeta = null;
      if (!destiny) {
        // 3. 新生成：走统一编排核心（处境判断→契约→生成→验收→修复/降级）
        const journeyContext = journeyEnabled()
          ? require('./journey').buildJourneyContext(record.id)
          : null;
        const result = await createStoryForRecord({
          feeling: record.feeling,
          creature: record.creature,
          water: record.water,
          replyTimeLabel: getReplyTimeLabel(record.reply_at - record.created_at),
          journeyContext
        });
        storyMeta = result.meta;
        // 幂等落库：并发下若他人已写入，以库内版本为准（race-safe）
        db.insertDestinyOnce({
          id: `DST-${record.id}`,
          recordId: record.id,
          openid: record.openid,
          segments: result.destiny.segments,
          location: result.destiny.location,
          visual: result.destiny.visual,
          visualForImage: result.destiny.visualForImage,
          reply: result.destiny.reply,
          ending: result.destiny.ending,
          semanticStatus: result.meta.status,
          judgeMeta: {
            pipelineVersion: result.meta.pipelineVersion,
            status: result.meta.status,
            notes: result.meta.notes,
            repairs: result.meta.repairs,
            semantics: result.meta.semantics,
            situation: result.meta.situation,
            usage: { generation: result.meta.generation, judging: result.meta.judging },
            totalLatencyMs: result.meta.totalLatencyMs,
            textModel: result.meta.textModel,
            journeyApplied: result.meta.journeyApplied
          },
          contractMeta: result.meta.contract,
          frozenAt: Date.now() // 生成即冻结：后续重复调用不得覆盖
        });
        destiny = db.getDestinyByRecordId(record.id);
        if (storyMeta) {
          console.log(`[pipeline] ${record.id} status=${storyMeta.status} situation=${storyMeta.situation?.supported?.length ?? '?'} repairs=${storyMeta.repairs?.length ?? 0} gen=${storyMeta.generation?.calls ?? 0} judge=${storyMeta.judging?.calls ?? 0} ${storyMeta.totalLatencyMs ?? '?'}ms`);
        }
      }

      // 4. 回信与画面描述都从同一个已接受版本派生
      const destinySummary = summarizeDestiny(destiny);
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
      db.updateReply(record.id, { ...reply, image });

      // 5. 回信已公开展示 → 冻结故事版本（展示过的事件和结局不可改写）
      db.freezeDestiny(record.id);
      return { ...reply, image };
    } finally {
      db.clearReplyGenerating(record.id);
      inflight.delete(record.id);
    }
  })();
  inflight.set(record.id, job);
  return job;
}

// 兼容旧名：调度器与既有调用方语义不变
const generateReplyForRecord = ensureStoryAndReply;

module.exports = {
  PRE_GENERATE_MS,
  getReplyTimeLabel,
  shouldGenerateNow,
  ensureStoryAndReply,
  generateReplyForRecord
};
