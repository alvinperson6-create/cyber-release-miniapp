// 赛博放生 · 生物事件旅程（第二阶段实验，JOURNEY_ENABLED 默认关闭）
//
// 分工纪律（handoff §5.2）：
// - 程序先筛选当前合法动作（本版全部节点合法集合一致，由代码拥有）；JEV 只在合法集合里
//   判断生物此刻的行为；JEV 不可用时回退到确定性规则（按行为倾向），绝不悬空
// - 动作后果与状态迁移完全由代码拥有（OUTCOMES 表），LLM 不得修改权威状态
// - 只在事件节点调用模型；事件结果落账本后不再重问（重放零模型调用）
// - 留言先判意图，程序只改变允许的行为倾向；任意文本不成为系统指令
// - 已发生事件不可改写：留言只影响 appliedVersion 之后的事件；旅程冻结后留言被拒绝
// - 最终回信只能根据已完成事件生成（buildJourneyContext 供创作契约；账本一致性进验收）
// - 时间：事件节点按记录回信时间轴等距展开，可经 JOURNEY_TIME_SCALE 缩放（部署配置，
//   非线上推进 API）；推进入口为惰性（读取时）+ 调度器，均复用同一生产函数

const crypto = require('node:crypto');
const db = require('./db');
const { journeyEnabled } = require('./flags');
const { jevJudge, isJeVEnabled } = require('./jev');

const JOURNEY_VERSION = 'journey-v1';

// 三个事件节点（演示场景：会答应对一切的生物，被不断加码）
const EVENT_NODES = [
  {
    key: 'crab_shift',
    title: '螃蟹请代班',
    desc: '巡逻队的螃蟹举着钳子找上门："兄弟，我钳子发炎了，帮我代个班呗，就一晚上。"'
  },
  {
    key: 'weed_move',
    title: '水草请搬家',
    desc: '一丛水草拦住去路："我 roots 都泡坏了，浅滩那边舒服，你能帮我搬过去吗？就一丛草而已。"'
  },
  {
    key: 'fete_org',
    title: '湖长请组织联欢会',
    desc: '湖长慢悠悠游过来："听说你最靠得住。月底的水底联欢会，从节目单到音响，就交给你统筹啦。"'
  }
];

const LEGAL_ACTIONS = ['答应', '拒绝', '协商', '求助', '离开'];

// 动作后果表：代码拥有（确定性）；delta 记录状态迁移需要的最小字段
const OUTCOMES = {
  crab_shift: {
    答应: { text: '它答应替螃蟹代班。巡逻班次瞬间翻倍，鳍都游僵了，螃蟹挥挥钳子消失在夜色里。', delta: { extraDuty: 1 } },
    拒绝: { text: '它第一次说了"不"。螃蟹愣了三秒，反而松了口气："行，那我自己顶，其实……也就疼一点。"', delta: { refusals: 1 } },
    协商: { text: '它跟螃蟹谈妥：只代前半夜，后半夜各回各家。螃蟹觉得这主意比它的钳子还硬。', delta: { deals: 1 } },
    求助: { text: '它拉来一只水母一起值班。三个"不好意思说不"的家伙挤在一个岗亭里互相叹气。', delta: { allies: 1 } },
    离开: { text: '它假装没听见，溜进深水区，愧疚地连吐了两个泡。螃蟹在原地等了很久。', delta: { avoidances: 1 } }
  },
  weed_move: {
    答应: { text: '它连夜帮水草连根拔起搬到浅滩。水草感动得冒泡，它的腰已经直不起来了。', delta: { extraDuty: 1 } },
    拒绝: { text: '它说"这次真的不行"。水草想了想："没事，那我等风。风也是个热心肠。"', delta: { refusals: 1 } },
    协商: { text: '它只帮水草挪过最后一段深沟，前半程水草自己顺着水流飘，像跳了一段双人舞。', delta: { deals: 1 } },
    求助: { text: '它召来一群小鱼组成搬运队，浩浩荡荡。水草被抬走时，鱼群还在喊号子。', delta: { allies: 1 } },
    离开: { text: '它绕了两里地躲开水草的视线，绕路的时候一直在心里道歉。', delta: { avoidances: 1 } }
  },
  fete_org: {
    答应: { text: '它接下联欢会总调度。节目单改了十一版，音响试到深夜，忙到忘了自己是条鱼。', delta: { extraDuty: 2 } },
    拒绝: { text: '它清了清嗓子拒绝湖长。湖长愣住后大笑："行啊，那你就当嘉宾，什么都别干，就出席！"', delta: { refusals: 1 } },
    协商: { text: '它只认领了音响那一摊，其余推给爱出风头的龙虾。龙虾当场表演了一段激情主持。', delta: { deals: 1 } },
    求助: { text: '它拉上螃蟹一起筹备。两个不太会拒绝的家伙，第一次学会了互相打气："咱可以商量着来。"', delta: { allies: 1 } },
    离开: { text: '它溜了。没有它的联欢会居然照常举办，它躲在石头后面看完了全场，还跟着哼了歌。', delta: { avoidances: 1 } }
  }
};

// 行为倾向 → 规则回退动作（JEV 不可用时的确定性兜底）
const FALLBACK_ACTION = {
  compliant: '答应',
  assertive: '拒绝',
  self_care: '协商'
};

// 事件时间轴：在「回信预生成窗口」之前等距铺开三个事件，
// 保证最终回信生成时事件已尽可能完成；JOURNEY_TIME_SCALE 供演示/测试压缩节奏（部署配置，非线上推进 API）
const PRE_GENERATE_WINDOW_MS = 10 * 60 * 1000; // 与 reply-generator.PRE_GENERATE_MS 对齐

function eventTimeOf(journey, nodeIndex) {
  const scale = parseFloat(process.env.JOURNEY_TIME_SCALE || '1') || 1;
  const waitMs = Math.max(0, journey.reply_at - journey.created_at);
  const available = Math.max(0, waitMs - PRE_GENERATE_WINDOW_MS);
  const step = Math.max(2000, (available / 4) * scale);
  return journey.created_at + step * (nodeIndex + 1);
}

function createJourney(record) {
  const id = `JRN-${record.id}`;
  db.createJourney({
    id,
    recordId: record.id,
    openid: record.openid,
    creature: record.creature,
    water: record.water,
    feeling: record.feeling,
    seed: crypto.randomInt(0, 2147483647),
    createdAt: record.created_at,
    replyAt: record.reply_at
  });
  return db.getJourneyByRecordId(record.id);
}

/** 在合法集合内判断生物行为：JEV 优先，不可用时确定性规则回退（记录来源） */
async function decideAction(journey, node, { deps } = {}) {
  const judge = deps?.jevJudge || jevJudge;
  const ledger = JSON.parse(journey.ledger || '[]');
  if (isJeVEnabled()) {
    try {
      const state = JSON.stringify({
        生物: journey.creature,
        当前行为倾向: journey.behavior_tendency,
        已发生事件: ledger.map(e => `${e.eventTitle}→${e.action}`),
        本事件: { 标题: node.title, 情境: node.desc }
      });
      const r = await judge(state, {
        action: {
          type: 'choice',
          instructions: `这只生物此刻的行为倾向是「${journey.behavior_tendency}」。结合它已经历的事件，判断它面对这件事最可能怎么做？只从以下动作中选择。`,
          criteria: {
            '答应': '接下请求，把事情揽到自己身上',
            '拒绝': '明确说"不"，不接这个请求',
            '协商': '接一部分，谈条件，只做到某个程度',
            '求助': '自己不上，拉别的伙伴一起分担',
            '离开': '不回应，绕开这件事'
          }
        }
      });
      const choice = r.answers.action.choice;
      if (LEGAL_ACTIONS.includes(choice)) {
        return { action: choice, source: 'jev', usage: r.usage, model: r.model };
      }
    } catch (e) {
      // fallthrough to rule
    }
  }
  return { action: FALLBACK_ACTION[journey.behavior_tendency] || '答应', source: 'rule_fallback' };
}

/**
 * 推进旅程（生产函数；惰性读取与调度器共用）。
 * @param {string} recordId
 * @param {{now?:number, deps?:object}} opts now 可注入（测试用可控时钟）
 */
async function advanceJourney(recordId, opts = {}) {
  if (!journeyEnabled()) return null;
  const now = opts.now ?? Date.now();
  let journey = db.getJourneyByRecordId(recordId);
  if (!journey) return null;

  // 已回信（故事已冻结）→ 冻结旅程：已展示事件与结局不可再变
  if (!journey.terminal_status && db.getDestinyByRecordId(recordId)) {
    journey = db.saveJourney({ ...journey, terminal_status: 'letter_frozen', frozen_at: now, state_version: journey.state_version + 1 });
    return publicView(journey);
  }
  if (journey.terminal_status) return publicView(journey);

  const ledger = JSON.parse(journey.ledger || '[]');
  let version = journey.state_version;
  let changed = false;
  while (journey.event_cursor < EVENT_NODES.length) {
    const node = EVENT_NODES[journey.event_cursor];
    if (eventTimeOf(journey, journey.event_cursor) > now) break;
    const { action, source } = await decideAction(journey, node, opts);
    const outcome = OUTCOMES[node.key][action];
    ledger.push({
      index: journey.event_cursor,
      eventKey: node.key,
      eventTitle: node.title,
      eventDesc: node.desc,
      action,
      actionSource: source,
      outcomeText: outcome.text,
      delta: outcome.delta,
      appliedVersion: version + 1,
      at: now
    });
    version += 1;
    journey = { ...journey, ledger: JSON.stringify(ledger), event_cursor: journey.event_cursor + 1, state_version: version };
    changed = true;
  }

  if (changed) {
    journey = db.saveJourney({ ...journey, state_version: version, updated_at: now });
  }
  return publicView(journey);
}

/** 留言：先判意图，再由程序决定允许的影响（改倾向，只作用于未来事件） */
async function leaveMessage(recordId, text, opts = {}) {
  if (!journeyEnabled()) return { ok: false, code: 'journey_disabled' };
  const journey = db.getJourneyByRecordId(recordId);
  if (!journey) return { ok: false, code: 'journey_not_found' };
  if (journey.terminal_status) return { ok: false, code: 'journey_ended', message: '本轮旅程已结束，留言请在下次放生时带上' };
  if (journey.message_text) return { ok: false, code: 'already_has_message', message: '本轮已经留过言了（一句话留言，一词千金）' };
  const clean = String(text || '').trim().slice(0, 50);
  if (!clean) return { ok: false, code: 'empty_message' };

  const judge = opts.deps?.jevJudge || jevJudge;
  let intent = 'other';
  let intentSource = 'keyword_fallback';
  let intentUsage = null;
  if (isJeVEnabled()) {
    try {
      const r = await judge(clean, {
        intent: {
          type: 'choice',
          instructions: '这是一位用户对自己放生的虚拟生物说的话。判断这句话的核心意图。',
          criteria: {
            permission_to_refuse: '授权或鼓励生物去拒绝别人的请求（如"你可以拒绝""大胆说不"）',
            other: '其他意图（闲聊、许愿、安慰、看不懂等）'
          }
        }
      });
      intent = r.answers.intent.choice;
      intentSource = 'jev';
      intentUsage = r.usage;
    } catch (e) {
      // 回退关键词
    }
  }
  if (intentSource === 'keyword_fallback') {
    if (/拒绝|说不|别答应|推掉|大胆|说 ?no/.test(clean)) intent = 'permission_to_refuse';
  }

  // 原子写守卫：并发留言只可能有一条成功（一词千金的最终保证）
  const appliedAt = opts.now ?? Date.now();
  const applied = db.saveJourneyMessage(recordId, {
    messageText: clean,
    messageMeta: JSON.stringify({ intent, intentSource, intentUsage, appliedAt, effect: intent === 'permission_to_refuse' ? 'tendency->assertive' : 'none' }),
    behaviorTendency: intent === 'permission_to_refuse' ? 'assertive' : journey.behavior_tendency,
    tendencySource: intent === 'permission_to_refuse' ? 'message' : journey.tendency_source
  });
  if (!applied) {
    const latest = db.getJourneyByRecordId(recordId);
    return { ok: false, code: latest?.terminal_status ? 'journey_ended' : 'already_has_message', message: '本轮已经留过言了（一句话留言，一词千金）' };
  }
  return { ok: true, intent, effect: intent === 'permission_to_refuse' ? 'tendency->assertive' : 'none' };
}

/** 供创作契约使用：已完成事件账本（只含已发生事实） */
function buildJourneyContext(recordId) {
  if (!journeyEnabled()) return null;
  const journey = db.getJourneyByRecordId(recordId);
  if (!journey) return null;
  const ledger = JSON.parse(journey.ledger || '[]');
  if (!ledger.length) return null;
  const ledgerSummary = ledger
    .map(e => `${e.index + 1}. ${e.eventTitle} → 生物选择了「${e.action}」：${e.outcomeText}`)
    .join('\n');
  const tendencyNote = journey.tendency_source === 'message'
    ? `用户留言「${journey.message_text}」后，生物学会了拒绝（后半程行为倾向：assertive）`
    : null;
  return { ledgerSummary, tendencyNote, journeyId: journey.id, eventCount: ledger.length };
}

function publicView(journey) {
  const ledger = JSON.parse(journey.ledger || '[]');
  const pending = journey.event_cursor < EVENT_NODES.length ? EVENT_NODES[journey.event_cursor] : null;
  return {
    id: journey.id,
    recordId: journey.record_id,
    creature: journey.creature,
    water: journey.water,
    stateVersion: journey.state_version,
    eventCursor: journey.event_cursor,
    totalEvents: EVENT_NODES.length,
    events: ledger.map(e => ({
      index: e.index, title: e.eventTitle, desc: e.eventDesc, action: e.action, outcome: e.outcomeText, actionSource: e.actionSource, at: e.at
    })),
    nextEvent: pending ? { title: pending.title, at: eventTimeOf(journey, journey.event_cursor) } : null,
    tendency: journey.behavior_tendency,
    message: journey.message_text
      ? { text: journey.message_text, ...(journey.message_meta ? JSON.parse(journey.message_meta) : {}) }
      : null,
    terminalStatus: journey.terminal_status,
    frozenAt: journey.frozen_at
  };
}

module.exports = {
  JOURNEY_VERSION,
  EVENT_NODES,
  LEGAL_ACTIONS,
  OUTCOMES,
  FALLBACK_ACTION,
  createJourney,
  advanceJourney,
  leaveMessage,
  buildJourneyContext,
  publicView,
  eventTimeOf
};
