// 赛博放生 · 回应信号命令
//
// 阶段 C.3 的核心修复：回复必须显式指向一个 signalMessageId / encounterId。
//
// 原实现取"最新遭遇且状态为 signal_sent"，导致：
//   - 用户对旧信号的迟到回复会绑定到新信号上
//   - 无法区分"回复哪条信号"
// 现在 Host 核对目标、归属、当前状态和截止时间：
//   1. 目标不存在 / 越权 / 本程已结束 → 按契约拒绝
//   2. 截止已过或目标已决，但目标可追溯且本程仍允许留言
//      → 明确记录 ontime=false / late，只作本程后续未决参考
//      不占新信号补给位、不改原决定
//   3. 其他冲突给明确结果，**绝不自动绑定最新信号**

const { fingerprintOf, parseReplyCommand } = require('../../../../shared/contracts/commands');

function createReplyCommand({ store, clock }) {
  function execute({ ownerKey, journeyId, input }) {
    const parsed = parseReplyCommand(input);
    if (!parsed.ok) return { ok: false, code: parsed.code };
    const value = parsed.value;

    const journey = store.getOwnedJourney(journeyId, ownerKey);
    if (!journey) return { ok: false, code: 'journey_not_found' };

    const now = clock.now();

    // 本程已结束：留言不带进下一程
    if (['ended_user', 'ended_natural', 'aborted'].includes(journey.status)) {
      return { ok: false, code: 'journey_ended' };
    }

    const fingerprint = fingerprintOf('replyToSignal', value);
    if (value.requestId) {
      const prior = store.readCommandResult({ ownerKey, operation: 'replyToSignal', requestId: value.requestId, fingerprint });
      if (prior.conflict) return { ok: false, code: 'idempotency_conflict' };
      if (prior.hit) return { ...prior.result, replayed: true };
    }

    // —— 定位明确目标（不再猜"最新遭遇"）——
    let encounter = null;
    if (value.signalMessageId) {
      encounter = store.getEncounterBySignalMessageId(journeyId, value.signalMessageId);
      if (!encounter) return { ok: false, code: 'signal_not_found' };
    } else {
      encounter = store.getEncounter(value.encounterId);
      if (!encounter) return { ok: false, code: 'encounter_not_found' };
    }

    // 目标必须确实寄出过信号，否则不接受"随便指个遭遇"
    if (!encounter.signalMessageId) return { ok: false, code: 'signal_not_found' };

    const decided = ['decided', 'resolved'].includes(encounter.status);
    const expired = encounter.signalDueAt != null && now > encounter.signalDueAt;
    // 暂停中的旅程不接受新的补给（避免暂停期间悄悄改变决策输入）
    const paused = journey.status === 'paused';

    // 仍可留言的唯一条件：目标可追溯，且本程还没结束
    const canRecord = true;

    const db = store.getDb();
    try {
      const tx = db.transaction(() => {
        const prior = store.readCommandResultIn(db, {
          ownerKey, operation: 'replyToSignal', requestId: value.requestId, fingerprint
        });
        if (prior.conflict) throw new IdemConflict();
        if (prior.replay) return { replay: true, result: prior.result };

        let result;

        if (decided || expired || paused) {
          // 迟到参考：只作为本程后续未决输入，不占补给位、不改原决定
          if (!canRecord) throw new ReplyRejected('journey_ended');
          const msgId = store.rid('MSG');
          store.insertMessage({
            id: msgId, journeyId, kind: 'user_reply', encounterId: encounter.id,
            text: value.text, status: 'late', sentAt: now, now,
            meta: {
              late: true,
              ontime: false,
              reason: decided ? 'target_decided' : (paused ? 'journey_paused' : 'signal_expired'),
              // 记录它迟到的事实，但不改写 encounter.supply_message_id
              lateReference: true
            }
          });
          result = {
            ok: true,
            ontime: false,
            late: true,
            encounterId: encounter.id,
            messageId: msgId,
            message: '这条回复来晚了：不会改写已发生的选择，只作为它之后面对未决之事时的参考'
          };
        } else {
          // 按时补给：占用该遭遇的补给位（条件更新，并发只有一条成功）
          const msgId = store.rid('MSG');
          const applied = store.attachSupply(encounter.id, msgId, now);
          if (applied) {
            store.insertMessage({
              id: msgId, journeyId, kind: 'user_reply', encounterId: encounter.id,
              text: value.text, status: 'sent', sentAt: now, now,
              meta: { ontime: true, late: false }
            });
            // 立即唤醒这件遭遇的决策（补给是决策证据，不是命令）
            store.insertTask({
              id: store.rid('TASK'), journeyId, kind: 'decide',
              dueAt: now, payload: { encounterId: encounter.id }, now
            });
            store.accelerateTask(journeyId, 'decide', now, now);
            result = { ok: true, ontime: true, late: false, encounterId: encounter.id, messageId: msgId };
          } else {
            // 另一条并发回复已抢到补给位：这条按迟到参考记录
            const lateId = store.rid('MSG');
            store.insertMessage({
              id: lateId, journeyId, kind: 'user_reply', encounterId: encounter.id,
              text: value.text, status: 'late', sentAt: now, now,
              meta: { late: true, ontime: false, reason: 'supply_taken' }
            });
            result = {
              ok: true, ontime: false, late: true, encounterId: encounter.id, messageId: lateId,
              message: '这个信号已经收到过一条补给了：这条只作为它之后面对未决之事时的参考'
            };
          }
        }

        store.recordCommandResult(db, {
          ownerKey, operation: 'replyToSignal', requestId: value.requestId,
          fingerprint, result, now
        });
        return { replay: false, result };
      });
      const out = tx();
      if (out.replay) return { ...out.result, replayed: true };
      return out.result;
    } catch (err) {
      if (err instanceof IdemConflict) return { ok: false, code: 'idempotency_conflict' };
      if (err instanceof ReplyRejected) return { ok: false, code: err.code };
      throw err;
    }
  }

  return { execute };
}

class IdemConflict extends Error {}
class ReplyRejected extends Error {
  constructor(code) { super(code); this.code = code; }
}

module.exports = { createReplyCommand };
