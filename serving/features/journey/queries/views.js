// 赛博放生 · 公开查询（只读）
//
// 边界（阶段 3.1）：queries 只获得读取能力，不能调用模型、不能写入业务状态。
// 对只读 adapter 的依赖允许，但不能取得原始数据库写接口——因此这里只调用
// store 的读取函数，不调用 getDb() 拿写句柄（公共脉搏是唯一例外，且只 SELECT）。
//
// 读取 API 绝不触发模型生成；页面在线与否不影响推进。

const {
  toJourneyViewDto, computePhase, CONTRACT_VERSION
} = require('../../../../shared/contracts/dto');
const { CREATURES, WATERS } = require('../../../../shared/contracts/vocabulary');
const { MESSAGE_KIND, TERMINAL_STATUSES } = require('../../../../shared/contracts/enums');

function createJourneyQueries({ store, clock }) {
  /** 本程状态 + 已寄出的信号/来信（纯读取） */
  function getJourneyView({ ownerKey, journeyId }) {
    const journey = store.getOwnedJourney(journeyId, ownerKey);
    if (!journey) return null;

    const now = clock.now();
    const latestEnc = store.getLatestEncounter(journeyId);
    const motivation = store.getMotivation(journeyId);
    const allMessages = store.getMessages(journeyId);
    // 未来投递时间的消息不得提前可见
    const visible = allMessages.filter(m => m.sentAt <= now);
    const facts = store.getFacts(journeyId);
    const lastResolved = store.readLastResolved(journeyId);

    const signalMsg = latestEnc?.signalMessageId
      ? allMessages.find(m => m.id === latestEnc.signalMessageId)
      : null;

    const view = toJourneyViewDto(journey, {
      latestEnc, motivation, allMessages: visible,
      facts: facts.length, lastResolved, now
    });

    // 待回应信号：只公开这一件已寄出（sent_at 已到）信号的未决遭遇
    let pendingSignal = null;
    if (latestEnc && latestEnc.status === 'signal_sent' && signalMsg && signalMsg.sentAt <= now) {
      pendingSignal = {
        encounterId: latestEnc.id,
        messageId: latestEnc.signalMessageId,
        text: signalMsg.text,
        sentAt: signalMsg.sentAt,
        dueAt: latestEnc.signalDueAt,
        remainingMs: Math.max(0, latestEnc.signalDueAt - now),
        replied: !!latestEnc.supplyMessageId,
        actions: (latestEnc.proposal?.actions || []).map(a => ({ id: a.id, label: a.label, cost: a.cost }))
      };
    }

    return { ...view, pendingSignal };
  }

  /** 旅程回顾时间线：只在结束后开放（纯读取，不触模型） */
  function getJourneyTimeline({ ownerKey, journeyId }) {
    const journey = store.getOwnedJourney(journeyId, ownerKey);
    if (!journey) return { ok: false, code: 'journey_not_found' };
    if (!TERMINAL_STATUSES.includes(journey.status)) {
      return {
        ok: false, code: 'journey_not_finished',
        message: '旅程还在进行中：它想自己决定什么时候讲给你听。这一程结束后，这里会展开完整时间线。'
      };
    }

    const now = clock.now();
    const encounters = store.getEncounters(journeyId);
    const messages = store.getMessages(journeyId).filter(m => m.sentAt <= now);
    const motivation = store.getMotivation(journeyId);

    const nodes = [];
    nodes.push({
      kind: 'opening',
      at: encounters.length ? encounters[0].createdAt : journey.created_at,
      goal: journey.goal || null,
      creatureName: CREATURES[journey.species]?.name || journey.species,
      creatureEmoji: CREATURES[journey.species]?.emoji || '🐚',
      waterName: WATERS[journey.water]?.name || journey.water,
      motivation: motivation ? {
        status: motivation.status,
        rawText: motivation.rawText,
        items: (motivation.items || []).filter(i => i.usable).map(i => i.label)
      } : null
    });

    for (const enc of encounters) {
      const actions = enc.proposal?.actions || [];
      const chosen = actions.find(a => a.id === enc.chosenAction) || null;
      nodes.push({
        kind: 'encounter',
        at: enc.updatedAt,
        seq: enc.seq,
        title: enc.proposal?.title || `第 ${enc.seq} 站`,
        situation: enc.proposal?.situation || null,
        options: actions.map(a => ({ label: a.label, cost: a.cost })),
        chosenAction: chosen ? chosen.label
          : (enc.chosenAction === 'none_fit' ? '（都不合适，搁下了）' : enc.chosenAction),
        chosenCost: chosen ? chosen.cost : null,
        decisionSource: enc.decisionSource,
        narrative: enc.outcome?.narrative || null,
        outcomeFacts: (enc.outcome?.facts || []).map(f => f.content),
        settled: enc.status === 'resolved',
        unresolvedNote: enc.status !== 'resolved' ? '这件事还没落定，旅程就先停在了这里。' : null,
        hadSignal: !!enc.signalMessageId
      });
    }

    for (const m of messages) {
      nodes.push({
        kind: m.kind,
        at: m.sentAt,
        title: m.title || null,
        text: m.text,
        image: m.image || null,
        imageStatus: m.imageStatus || null,
        status: m.status,
        late: !!m.meta?.late,
        isFinal: m.kind === MESSAGE_KIND.FINAL_LETTER
      });
    }

    nodes.sort((a, b) => a.at - b.at);
    const reasonText = journey.ending_reason === 'user' ? '你结束了这段旅程' : '这一程自然收束';
    nodes.push({
      kind: 'ending',
      at: Math.max(journey.updated_at || 0, ...nodes.map(n => n.at)),
      reason: journey.ending_reason, reasonText, status: journey.status
    });

    return { ok: true, timeline: { journeyId, status: journey.status, nodes, contractVersion: CONTRACT_VERSION } };
  }

  function listJourneys(ownerKey) {
    const now = clock.now();
    return store.getJourneysByOwner(ownerKey).map(j => {
      const msgs = store.getMessages(j.id)
        .filter(m => m.sentAt <= now && ['signal', 'letter', 'final_letter'].includes(m.kind));
      const last = msgs[msgs.length - 1];
      return {
        id: j.id, creatureId: j.creature_id, species: j.species,
        creatureName: CREATURES[j.species]?.name || j.species,
        creatureEmoji: CREATURES[j.species]?.emoji || '🐚',
        water: j.water, waterName: WATERS[j.water]?.name || j.water,
        status: j.status, phase: computePhase(j, store.getLatestEncounter(j.id)),
        tone: j.tone, eventCount: j.event_count,
        lastMessageAt: last ? last.sentAt : null,
        lastMessageTitle: last ? (last.title || null) : null,
        createdAt: j.created_at
      };
    });
  }

  function listCreatures(ownerKey) {
    return store.getCreaturesByOwner(ownerKey).map(c => {
      const journeys = store.readJourneysByCreature(c.id);
      const active = journeys.find(j => ['preparing', 'active', 'paused'].includes(j.status));
      return {
        id: c.id, species: c.species,
        creatureName: CREATURES[c.species]?.name || c.species,
        creatureEmoji: CREATURES[c.species]?.emoji || '🐚',
        journeyCount: journeys.length,
        hasActiveJourney: !!active,
        activeJourneyId: active ? active.id : null,
        createdAt: c.created_at
      };
    });
  }

  /** 公共脉搏：只返回累计数与水域/时间，绝不暴露用户原话 */
  function getPublicPulse() {
    return store.readPublicPulse();
  }

  return { getJourneyView, getJourneyTimeline, listJourneys, listCreatures, getPublicPulse };
}

module.exports = { createJourneyQueries };
