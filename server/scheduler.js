// 赛博放生 · 后台调度器（v2）
//
// - 任务按到期时间公平取用（due_at 升序 + 单旅程每 tick 限额），先到先租
// - 租约过期自动回收：进程重启/崩溃后任务回到 pending，继续推进
// - 失败按次数退避重试；超过上限任务标 failed，旅程如实暂停（不伪装成自主收束）
// - tick 由 index.js 周期调用；测试与真实路径验证可手动调用同一 tick
// 时钟一律走 clock.now()（可注入虚拟时钟加速生产调度）

const db = require('./db');
const clock = require('./clock');
const { guards } = require('./flags');
const orchestrator = require('./orchestrator');

async function tick({ budget = 3 } = {}) {
  const now = clock.now();
  db.recoverExpiredLeases(now);
  const recovered = orchestrator.reconcileJourneys(now);
  if (recovered) console.log(`[scheduler] reconcile created ${recovered} recovery task(s)`);

  const tasks = db.claimDueTasks(now, { limit: budget, leaseMs: guards.leaseMs(), maxPerJourney: 1 });
  const results = [];
  let lastNow = now;
  for (const task of tasks) {
    const outcome = await orchestrator.runTask(task, { now: clock.now() }).catch(err => ({ status: 'retry', reason: err.message }));
    lastNow = clock.now();
    if (outcome.status === 'done') {
      db.completeTask(task.id, lastNow);
    } else if (outcome.status === 'retry') {
      if (task.attempts >= guards.maxTaskAttempts()) {
        db.failTask(task.id, outcome.reason || 'retry_limit', lastNow);
        orchestrator.pauseJourney(task.journey_id, 'task_retry_exhausted', {
          now: lastNow,
          notice: `服务提示：旅程因模型服务连续失败已暂停（${String(outcome.reason || '').slice(0, 60)}）。这不是生物的来信。`
        });
        console.warn(`[scheduler] task ${task.id}(${task.kind}) failed after ${task.attempts} attempts: ${outcome.reason}`);
      } else {
        db.retryTask(task.id, lastNow + guards.backoffMs(task.attempts), lastNow);
      }
    } else if (outcome.status === 'failed') {
      db.failTask(task.id, outcome.reason, lastNow);
    }
    results.push({ id: task.id, kind: task.kind, result: outcome.status });
  }
  return { claimed: tasks.length, results, at: lastNow };
}

function start(intervalMs) {
  const ms = intervalMs || guards.tickMs();
  const timer = setInterval(() => {
    tick().catch(err => console.error('[scheduler] tick error:', err.message));
  }, ms);
  timer.unref?.();
  return timer;
}

module.exports = { tick, start };
