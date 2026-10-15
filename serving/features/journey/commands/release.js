// 赛博放生 · 放生 / 建程命令
//
// 阶段 C：命令有 requestId 幂等键，按 owner 与操作分域。
// 同键同 payload 返回稳定结果；同键不同 payload 返回冲突。
// 去重结果与业务变化在同一原子边界持久化，重启后仍有效。

const { fingerprintOf, parseReleaseCommand } = require('../../../../shared/contracts/commands');
const { CREATURES, WATERS } = require('../../../../shared/contracts/vocabulary');
const { guards } = require('../../../adapters/guards');
const { COMMIT_RESULT } = require('../../../../shared/contracts/enums');

function createReleaseCommand({ store, clock, ledger }) {
  /**
   * 放生：先持久化并立即返回 preparing 回执。
   * 首个模型调用在后台 opening 任务完成，不阻塞可见成功状态。
   */
  function execute({ ownerKey, requestId, input }) {
    const parsed = parseReleaseCommand(input);
    if (!parsed.ok) return { ok: false, code: parsed.code };
    const value = parsed.value;

    if (!guards.journeyEnabled()) return { ok: false, code: 'journey_disabled' };
    if (!CREATURES[value.species]) return { ok: false, code: 'invalid_species' };
    if (!WATERS[value.water]) return { ok: false, code: 'invalid_water' };

    const now = clock.now();
    const fingerprint = fingerprintOf('release', value);

    // 幂等命中：同键同载荷直接返回既有结果，不重复建程
    if (value.requestId) {
      const prior = store.readCommandResult({ ownerKey, operation: 'release', requestId: value.requestId, fingerprint });
      if (prior.conflict) return { ok: false, code: 'idempotency_conflict' };
      if (prior.hit) return { ...prior.result, replayed: true };
    }

    // 复用既有生物时先校验归属与种类；新生物在事务内创建
    let creature = null;
    if (value.creatureId) {
      creature = store.getOwnedCreature(value.creatureId, ownerKey);
      if (!creature) return { ok: false, code: 'creature_not_found' };
      if (creature.species !== value.species) return { ok: false, code: 'species_mismatch' };
    }

    const db = store.getDb();
    try {
      const tx = db.transaction(() => {
        // 事务内再查一次，避免并发同键竞态（事务外那次只是为了快速返回）
        const prior = store.readCommandResultIn(db, {
          ownerKey, operation: 'release', requestId: value.requestId, fingerprint
        });
        if (prior.conflict) throw new IdemConflict();
        if (prior.replay) return { replay: true, result: prior.result };

        let c = creature;
        if (!value.creatureId) {
          const newCreatureId = store.rid('CRT');
          store.createCreature({ id: newCreatureId, ownerKey, species: value.species, now });
          c = store.getCreature(newCreatureId);
        }

        const journey = store.createJourney({
          id: store.rid('JRN'), creatureId: c.id, ownerKey,
          species: c.species, water: value.water, feeling: value.feeling, tone: value.tone, now
        });

        // 后台开局任务：立即到期，由调度器处理
        store.insertTask({
          id: store.rid('TASK'), journeyId: journey.id, kind: 'opening', dueAt: now, payload: {}, now
        });

        const result = {
          ok: true,
          journeyId: journey.id,
          status: journey.status,
          creatureId: c.id,
          species: c.species,
          water: journey.water,
          tone: journey.tone,
          createdAt: journey.created_at,
          serverTime: now
        };

        // 去重结果与业务变化同一事务
        store.recordCommandResult(db, {
          ownerKey, operation: 'release', requestId: value.requestId,
          fingerprint, result, now
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

class IdemConflict extends Error {}

module.exports = { createReleaseCommand, COMMIT_RESULT };
