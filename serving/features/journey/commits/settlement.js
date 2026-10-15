// 赛博放生 · 结算提交（commit 层）
//
// 边界（阶段 3.1）：
// - commit 协调业务条件与短事务，通过存储适配器执行原子写入
// - commit 事务内不能调用模型
// - workflow 不得绕过本模块直接写表
//
// 阶段 D 的核心要求：模型 await 之后、提交之前，重新核对
//   1. 当前旅程是否仍允许该变化（状态/版本）
//   2. 遭遇、已选动作、信号及补给等决策输入是否仍对应生成时的快照
//   3. 事实 + 机制卡 + 消息 + 旅程版本 + 后续排程意图 在同一短事务内一起提交
// 提交结果区分 applied / already_applied / stale / cancelled / conflict，
// 绝不把所有结果笼统记成"完成"。

const { COMMIT_RESULT } = require('../../../../shared/contracts/enums');

/**
 * 原子结算：encounter resolved + facts + 机制卡 + 旅程版本推进 + 排下一步任务。
 *
 * 排程意图与事实在同一事务内写入：不会出现"落账成功但永久丢下一步"。
 * @returns {{result:string, reason?:string}}
 */
function commitResolution({ store, journeyId, encounterId, outcome, outcomeStatus, contact, now, schedule }) {
  const db = store.getDb();

  // —— 提交前复核：旅程终态直接丢弃（用户已结束 / 自然收束）——
  // 读取由存储层提供：commit 不允许自己写 SQL
  const fresh = store.readJourneyForCommit(journeyId);
  if (!fresh) return { result: COMMIT_RESULT.STALE, reason: 'journey_missing' };
  if (['ended_user', 'ended_natural', 'aborted'].includes(fresh.status)) {
    return { result: COMMIT_RESULT.CANCELLED, reason: `journey_${fresh.status}` };
  }
  if (fresh.status !== 'active') {
    return { result: COMMIT_RESULT.STALE, reason: `journey_${fresh.status}` };
  }

  const freshEnc = store.getEncounter(encounterId);
  if (!freshEnc) return { result: COMMIT_RESULT.STALE, reason: 'encounter_missing' };
  if (freshEnc.status !== 'decided') {
    return { result: COMMIT_RESULT.STALE, reason: `encounter_${freshEnc.status}` };
  }

  const nextVersion = fresh.state_version + 1;

  try {
    const tx = db.transaction(() => {
      const okR = store.resolveEncounter(encounterId, { outcome, outcomeStatus, stateVersion: nextVersion, now });
      if (!okR) throw new CommitAbort(COMMIT_RESULT.CONFLICT, 'encounter_conflict');

      store.insertFacts(journeyId, encounterId, freshEnc.seq, outcome.facts, now);
      store.insertMechanismCard({
        creatureId: fresh.creature_id, journeyId, encounterId,
        card: outcome.mechanism_card, now
      });

      const okJ = store.updateJourney(journeyId, {
        event_count: fresh.event_count + 1, state_version: nextVersion
      }, { state_version: fresh.state_version });
      if (!okJ) throw new CommitAbort(COMMIT_RESULT.CONFLICT, 'journey_version_conflict');

      // 排程意图与事实同事务：不会丢下一步
      if (schedule) schedule(now, fresh.event_count + 1);
    });
    tx();
    return { result: COMMIT_RESULT.APPLIED };
  } catch (err) {
    if (err instanceof CommitAbort) return { result: err.result, reason: err.reason };
    throw err;
  }
}

/**
 * 开局提交：目标 + 首遭遇 + preparing→active + 唤醒决策任务（同一事务）。
 */
function commitOpening({ store, journeyId, goal, proposal, now, schedule }) {
  const db = store.getDb();
  const fresh = store.readJourneyForCommit(journeyId);
  if (!fresh) return { result: COMMIT_RESULT.STALE, reason: 'journey_missing' };
  if (fresh.status !== 'preparing') {
    return { result: fresh.status === 'active' ? COMMIT_RESULT.ALREADY_APPLIED : COMMIT_RESULT.CANCELLED,
             reason: `journey_${fresh.status}` };
  }
  const existing = store.getLatestEncounter(journeyId);
  if (existing) return { result: COMMIT_RESULT.ALREADY_APPLIED, reason: 'encounter_exists' };

  const nextVersion = fresh.state_version + 1;
  try {
    const tx = db.transaction(() => {
      const okJ = store.updateJourney(journeyId, {
        status: 'active', goal, state_version: nextVersion
      }, { status: 'preparing', state_version: fresh.state_version });
      if (!okJ) throw new CommitAbort(COMMIT_RESULT.CONFLICT, 'state_conflict');

      store.insertEncounter({
        id: store.rid('ENC'), journeyId, seq: 1,
        proposal, factsVersion: fresh.state_version, stateVersion: nextVersion, now
      });

      if (schedule) schedule(now);
    });
    tx();
    return { result: COMMIT_RESULT.APPLIED };
  } catch (err) {
    if (err instanceof CommitAbort) return { result: err.result, reason: err.reason };
    throw err;
  }
}

/**
 * 信号冻结提交：encounter proposed→signal_sent + 信号消息 + 到期任务（同一事务）。
 * @param urgency 紧急度来源如实记录
 */
function commitSignal({ store, journeyId, encounterId, text, dueAt, sendAt, urgency, now, schedule }) {
  const db = store.getDb();
  const fresh = store.readJourneyForCommit(journeyId);
  if (!fresh) return { result: COMMIT_RESULT.STALE, reason: 'journey_missing' };
  if (['ended_user', 'ended_natural', 'aborted'].includes(fresh.status)) {
    return { result: COMMIT_RESULT.CANCELLED, reason: `journey_${fresh.status}` };
  }

  const messageId = store.rid('MSG');
  try {
    const tx = db.transaction(() => {
      const okF = store.freezeEncounterSignal(encounterId, { messageId, dueAt, now });
      if (!okF) throw new CommitAbort(COMMIT_RESULT.STALE, 'encounter_not_proposed');

      store.insertMessage({
        id: messageId, journeyId, kind: 'signal', encounterId,
        text, status: 'sent', sentAt: sendAt, now,
        meta: {
          dueAt,
          encounterTitle: null, // 由调用方在事务外填入（纯展示字段）
          deadlineSource: urgency?.source || 'fallback_default',
          urgencyLevel: urgency?.level || null,
          urgencyMinutes: urgency?.minutes || null
        }
      });

      if (schedule) schedule(messageId, dueAt);
    });
    tx();
    return { result: COMMIT_RESULT.APPLIED, messageId };
  } catch (err) {
    if (err instanceof CommitAbort) return { result: err.result, reason: err.reason };
    throw err;
  }
}

/**
 * 行动决策提交（阶段 D 的关键护栏）。
 *
 * expectSupply：生成决策时的补给位快照。
 *   若生成后有新的按时补给到达 → 判 stale，丢弃这次决策并重算，
 *   避免"新增按时补给被旧的无补给决策悄悄吞掉"。
 */
function commitDecision({ store, journeyId, encounterId, action, source, meta, expectSupply, expectStateVersion, now, schedule }) {
  const db = store.getDb();
  const fresh = store.readJourneyForCommit(journeyId);
  if (!fresh) return { result: COMMIT_RESULT.STALE, reason: 'journey_missing' };
  if (['ended_user', 'ended_natural', 'aborted'].includes(fresh.status)) {
    return { result: COMMIT_RESULT.CANCELLED, reason: `journey_${fresh.status}` };
  }
  if (fresh.status !== 'active') return { result: COMMIT_RESULT.STALE, reason: `journey_${fresh.status}` };

  try {
    const tx = db.transaction(() => {
      const ok = store.decideEncounter(encounterId, {
        action, source, meta, now,
        expectSupply, expectStateVersion
      });
      if (!ok) {
        const enc = store.getEncounter(encounterId);
        if (!enc) throw new CommitAbort(COMMIT_RESULT.STALE, 'encounter_missing');
        if (!['proposed', 'signal_sent'].includes(enc.status)) {
          throw new CommitAbort(COMMIT_RESULT.ALREADY_APPLIED, `encounter_${enc.status}`);
        }
        // 状态仍可决策但条件不匹配 → 快照已过期，必须重算
        throw new CommitAbort(COMMIT_RESULT.STALE, 'snapshot_superseded');
      }
      if (schedule) schedule(now);
    });
    tx();
    return { result: COMMIT_RESULT.APPLIED };
  } catch (err) {
    if (err instanceof CommitAbort) return { result: err.result, reason: err.reason };
    throw err;
  }
}

/**
 * 来信提交：message + 终态推进或继续排程（同一事务）。
 *
 * 例外：给已存在的信件补图不经过这里（见 workflow 的 image 分支），
 * 因为补图必须验证消息归属与原操作，不创建新信、不推进剧情。
 */
function commitLetter({ store, journeyId, letter, kind, meta, now, schedule }) {
  const db = store.getDb();
  const fresh = store.readJourneyForCommit(journeyId);
  if (!fresh) return { result: COMMIT_RESULT.STALE, reason: 'journey_missing' };
  // 用户结束立即生效：在途模型返回后必须丢弃，不能把 ended_user 改成 ended_natural
  if (['ended_user', 'ended_natural', 'aborted'].includes(fresh.status)) {
    return { result: COMMIT_RESULT.CANCELLED, reason: `journey_${fresh.status}` };
  }
  if (fresh.status !== 'active') return { result: COMMIT_RESULT.STALE, reason: `journey_${fresh.status}` };

  const messageId = store.rid('MSG');
  const isFinal = kind === 'final_letter';
  try {
    const tx = db.transaction(() => {
      store.insertMessage({
        id: messageId, journeyId, kind,
        text: letter.text, title: letter.title,
        status: 'sent', sentAt: letter.sendAt, now, meta
      });

      if (isFinal) {
        const ok = store.updateJourney(journeyId, {
          status: 'ended_natural', ending_reason: 'natural'
        }, { status: 'active' });
        if (!ok) throw new CommitAbort(COMMIT_RESULT.STALE, 'status_changed');
        store.cancelTasksForJourney(journeyId, now);
      } else if (schedule) {
        schedule(now, messageId);
      }
    });
    tx();
    return { result: COMMIT_RESULT.APPLIED, messageId };
  } catch (err) {
    if (err instanceof CommitAbort) return { result: err.result, reason: err.reason };
    throw err;
  }
}

/**
 * 遭遇提案提交：只在最新遭遇已结算时插入新遭遇。
 * 使用 seq 唯一约束保证不会插入两个同序遭遇。
 */
function commitEncounterProposal({ store, journeyId, proposal, seq, now, schedule }) {
  const db = store.getDb();
  const fresh = store.readJourneyForCommit(journeyId);
  if (!fresh) return { result: COMMIT_RESULT.STALE, reason: 'journey_missing' };
  if (['ended_user', 'ended_natural', 'aborted'].includes(fresh.status)) {
    return { result: COMMIT_RESULT.CANCELLED, reason: `journey_${fresh.status}` };
  }
  if (fresh.status !== 'active') return { result: COMMIT_RESULT.STALE, reason: `journey_${fresh.status}` };

  try {
    const tx = db.transaction(() => {
      store.insertEncounter({
        id: store.rid('ENC'), journeyId, seq,
        proposal, factsVersion: fresh.state_version, stateVersion: fresh.state_version, now
      });
      if (schedule) schedule(now);
    });
    tx();
    return { result: COMMIT_RESULT.APPLIED };
  } catch (err) {
    if (String(err.message || '').includes('UNIQUE')) {
      return { result: COMMIT_RESULT.ALREADY_APPLIED, reason: 'seq_taken' };
    }
    throw err;
  }
}

class CommitAbort extends Error {
  constructor(result, reason) {
    super(reason);
    this.result = result;
    this.reason = reason;
  }
}

module.exports = {
  CommitAbort,
  commitOpening, commitSignal, commitDecision,
  commitResolution, commitLetter, commitEncounterProposal
};
