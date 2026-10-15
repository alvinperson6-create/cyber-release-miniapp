// 赛博放生 · 后台调度器
//
// 阶段 D 的核心：调度结果明确区分
//   done   —— 完成
//   defer  —— 正常等待（未到截止/未到投递时间），按 dueAt 重新排，**不消耗错误重试次数**
//   retry  —— 真实错误，退避重试，计入 attempts
//   failed —— 永久失败
//
// 租约纪律：完成/重试/失败都带 leaseKey 条件。旧 worker 的迟到结果影响 0 行，
// 不会覆盖新持有者，也不会把 cancelled 状态改回来。

const { SCHEDULER_RESULT } = require('../shared/contracts/enums');
const { guards } = require('./adapters/guards');

/**
 * 创建调度器实例。
 * @param deps.store 存储适配器
 * @param deps.clock 可控时钟
 * @param deps.orchestrator 编排器（提供 runTask / reconcileJourneys / pauseJourney）
 */
function createScheduler({ store, clock, orchestrator, logger = console }) {
  /**
   * 一个调度周期。
   * @param budget 本次最多认领多少任务
   */
  async function tick({ budget = 3 } = {}) {
    const now = clock.now();
    store.recoverExpiredLeases(now);
    const recovered = orchestrator.reconcileJourneys(now);
    if (recovered) logger.log?.(`[scheduler] reconcile created ${recovered} recovery task(s)`);

    const tasks = store.claimDueTasks(now, { limit: budget, leaseMs: guards.leaseMs(), maxPerJourney: 1 });
    const results = [];
    let lastNow = now;

    for (const task of tasks) {
      const leaseKey = task.lease_key;
      const outcome = await orchestrator.runTask(task, { now: clock.now() })
        .catch(err => ({ status: SCHEDULER_RESULT.RETRY, reason: err.message }));
      lastNow = clock.now();

      switch (outcome.status) {
        case SCHEDULER_RESULT.DONE: {
          const ok = store.completeTask(task.id, lastNow, leaseKey);
          results.push({ id: task.id, kind: task.kind, result: ok ? 'done' : 'stale_lease' });
          break;
        }
        case SCHEDULER_RESULT.DEFER: {
          // 正常等待：不消耗错误重试次数，不退避，按业务给出的 dueAt 重新排
          const dueAt = Math.max(outcome.dueAt ?? lastNow, lastNow);
          const ok = store.rescheduleTask(task.id, dueAt, lastNow, leaseKey);
          results.push({
            id: task.id, kind: task.kind,
            result: ok ? 'defer' : 'stale_lease',
            deferReason: outcome.reason || 'awaiting'
          });
          break;
        }
        case SCHEDULER_RESULT.RETRY: {
          if (task.attempts >= guards.maxTaskAttempts()) {
            const ok = store.failTask(task.id, outcome.reason || 'retry_limit', lastNow, leaseKey);
            if (ok) {
              orchestrator.pauseJourney(task.journey_id, 'task_retry_exhausted', {
                now: lastNow,
                notice: `服务提示：旅程因模型服务连续失败已暂停（${String(outcome.reason || '').slice(0, 60)}）。这不是生物的来信。`
              });
              logger.warn?.(`[scheduler] task ${task.id}(${task.kind}) failed after ${task.attempts} attempts: ${outcome.reason}`);
            }
            results.push({ id: task.id, kind: task.kind, result: ok ? 'failed' : 'stale_lease' });
          } else {
            const dueAt = lastNow + guards.backoffMs(task.attempts);
            const ok = store.rescheduleTask(task.id, dueAt, lastNow, leaseKey);
            results.push({ id: task.id, kind: task.kind, result: ok ? 'retry' : 'stale_lease' });
          }
          break;
        }
        case SCHEDULER_RESULT.FAILED: {
          const ok = store.failTask(task.id, outcome.reason || 'permanent', lastNow, leaseKey);
          results.push({ id: task.id, kind: task.kind, result: ok ? 'failed' : 'stale_lease' });
          break;
        }
        default: {
          // 未知状态按完成处理，但不记成功语义
          const ok = store.completeTask(task.id, lastNow, leaseKey);
          results.push({ id: task.id, kind: task.kind, result: ok ? 'unknown_status' : 'stale_lease' });
        }
      }
    }
    return { claimed: tasks.length, results, at: lastNow };
  }

  /** 周期启动。返回的 timer 由 runtime.stop() 负责清理 */
  function start(intervalMs) {
    const ms = intervalMs || guards.tickMs();
    const timer = setInterval(() => {
      tick().catch(err => logger.error?.('[scheduler] tick error:', err.message));
    }, ms);
    timer.unref?.();
    return timer;
  }

  return { tick, start };
}

module.exports = { createScheduler };
