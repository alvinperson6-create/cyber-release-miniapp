// 赛博放生 · 语气偏好与结束旅程命令
//
// 语气只影响未来；结束立即生效，不等模型写漂亮结尾。
// 两个命令都带 requestId 幂等键，结果与业务变化同事务持久化。

const { fingerprintOf, parseToneCommand, parseEndCommand } = require('../../../../shared/contracts/commands');
const { guards } = require('../../../adapters/guards');
const { CREATURES } = require('../../../../shared/contracts/vocabulary');

class IdemConflict extends Error {}
class NotFound extends Error {
  constructor(code) { super(code); this.code = code; }
}
class AlreadyEnded extends Error {}

/** 语气偏好：只影响未来遭遇的荒诞程度与文风 */
function createToneCommand({ store, clock }) {
  function execute({ ownerKey, journeyId, input }) {
    const parsed = parseToneCommand(input);
    if (!parsed.ok) return { ok: false, code: parsed.code };
    const value = parsed.value;

    const journey = store.getOwnedJourney(journeyId, ownerKey);
    if (!journey) return { ok: false, code: 'journey_not_found' };

    const now = clock.now();
    const fingerprint = fingerprintOf('setTone', value);
    if (value.requestId) {
      const prior = store.readCommandResult({ ownerKey, operation: 'setTone', requestId: value.requestId, fingerprint });
      if (prior.conflict) return { ok: false, code: 'idempotency_conflict' };
      if (prior.hit) return { ...prior.result, replayed: true };
    }

    const db = store.getDb();
    try {
      const tx = db.transaction(() => {
        const prior = store.readCommandResultIn(db, {
          ownerKey, operation: 'setTone', requestId: value.requestId, fingerprint
        });
        if (prior.conflict) throw new IdemConflict();
        if (prior.replay) return { replay: true, result: prior.result };

        const applied = store.updateJourney(journeyId, { tone: value.tone }, { status: journey.status });
        const result = applied
          ? { ok: true, tone: value.tone }
          : { ok: false, code: 'journey_not_found' };
        store.recordCommandResult(db, {
          ownerKey, operation: 'setTone', requestId: value.requestId, fingerprint, result, now
        });
        return { replay: false, result };
      });
      const out = tx();
      if (out.replay) return { ...out.result, replayed: true };
      return out.result;
    } catch (err) {
      if (err instanceof IdemConflict) return { ok: false, code: 'idempotency_conflict' };
      throw err;
    }
  }
  return { execute };
}

/** 用户主动结束：立即生效，新事件停止排程 */
function createEndCommand({ store, clock }) {
  function execute({ ownerKey, journeyId, input = {} }) {
    const parsed = parseEndCommand(input);
    if (!parsed.ok) return { ok: false, code: parsed.code };
    const value = parsed.value;

    const journey = store.getOwnedJourney(journeyId, ownerKey);
    if (!journey) return { ok: false, code: 'journey_not_found' };

    const now = clock.now();
    const fingerprint = fingerprintOf('endJourney', value);
    if (value.requestId) {
      const prior = store.readCommandResult({ ownerKey, operation: 'endJourney', requestId: value.requestId, fingerprint });
      if (prior.conflict) return { ok: false, code: 'idempotency_conflict' };
      if (prior.hit) return { ...prior.result, replayed: true };
    }

    const db = store.getDb();
    try {
      const tx = db.transaction(() => {
        const prior = store.readCommandResultIn(db, {
          ownerKey, operation: 'endJourney', requestId: value.requestId, fingerprint
        });
        if (prior.conflict) throw new IdemConflict();
        if (prior.replay) return { replay: true, result: prior.result };

        const applied = store.endJourneyByUser(journeyId, now);
        if (!applied) throw new AlreadyEnded();

        store.cancelTasksForJourney(journeyId, now);
        store.insertMessage({
          id: store.rid('MSG'), journeyId, kind: 'system',
          text: '服务提示：你已结束这段旅程。已收到的信还在信箱里；这只生物随时可以再次出发。',
          status: 'sent', sentAt: now, now
        });

        const result = { ok: true, status: 'ended_user' };
        store.recordCommandResult(db, {
          ownerKey, operation: 'endJourney', requestId: value.requestId, fingerprint, result, now
        });
        return { replay: false, result };
      });
      const out = tx();
      if (out.replay) return { ...out.result, replayed: true };
      return out.result;
    } catch (err) {
      if (err instanceof IdemConflict) return { ok: false, code: 'idempotency_conflict' };
      if (err instanceof AlreadyEnded) return { ok: false, code: 'already_ended' };
      throw err;
    }
  }
  return { execute };
}

module.exports = { createToneCommand, createEndCommand };
