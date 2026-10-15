// 赛博放生 · runtime factory
//
// 阶段 A 的硬要求：导入这个模块**不得**产生副作用——
// 不监听端口、不启动 timer、不连接生产库、不触发模型。
//
// 依赖装配集中在这里；production / HTTP 测试 / 场景开发服务共用同一个 factory，
// 只替换允许替换的依赖（阶段 B 的实例级注入）。
//
// runtime 提供 stop()/close()，关闭后不留残余端口或 timer。

const { createStore } = require('../adapters/store');
const { createClock } = require('../adapters/clock');
const { createTextModel } = require('../adapters/text-model');
const { createJev } = require('../adapters/jev');
const { createImageAdapter } = require('../adapters/image');
const { createOrchestrator, ORCHESTRATOR_VERSION } = require('../features/journey/workflows/orchestrator');
const { createScheduler } = require('../scheduler');

const { createReleaseCommand } = require('../features/journey/commands/release');
const { createReplyCommand } = require('../features/journey/commands/reply');
const { createToneCommand, createEndCommand } = require('../features/journey/commands/end');
const { createJourneyQueries } = require('../features/journey/queries/views');

const { guards } = require('../adapters/guards');

const REPO_ROOT = require('node:path').resolve(__dirname, '..', '..');

/**
 * 创建一个 runtime。
 *
 * @param opts.dbPath       SQLite 路径；不传则用 DB_PATH / 仓库默认位置
 * @param opts.clock        注入时钟实例；不传则用真实时钟
 * @param opts.textModel    文本模型适配器；不传则建真实适配器
 * @param opts.jev          JEV 适配器；不传则建真实适配器
 * @param opts.image        配图适配器；不传则建真实适配器
 * @param opts.open         是否打开数据库（false 时完全不碰 DB）
 * @param opts.logger
 */
function createRuntime(opts = {}) {
  const logger = opts.logger || console;

  // —— 时钟 ——
  const clock = opts.clock || createClock();

  // —— 存储 ——
  // 每个 runtime 一个 store 实例：两个 runtime 的库互不污染（阶段 B）
  // open=false 时不连接任何数据库：这让"只装配不启动"的检查可以安全运行
  const store = createStore({ path: opts.dbPath });
  let dbOpened = false;
  if (opts.open !== false) {
    store.initDb({ log: (m) => logger.log?.(`[db] ${m}`) });
    dbOpened = true;
  }

  // —— 统一记账回调：所有真实外部尝试都经过这里 ——
  // 关键：即使调用方注入了自己的 adapter（测试/场景），也必须包一层，
  // 否则注入路径会绕过台账与预算，"统一调用入口"就名存实亡。
  const onCall = (entry) => {
    if (!dbOpened) return;
    try {
      store.recordModelCall({ ...entry, now: entry.now ?? clock.now() });
    } catch (err) {
      logger.warn?.('[ledger] record failed:', err.message);
    }
  };

  /** 给注入的 adapter 套上统一记账；预算判定仍由 adapter 自己尊重 */
  function withLedger(adapter, { label }) {
    if (!adapter) return adapter;
    if (adapter.__ledgerWrapped) return adapter;
    const wrapped = {
      ...adapter,
      __ledgerWrapped: true,
      __label: label,
      invoke: async (params) => {
        const res = await adapter.invoke(params);
        // 只在 adapter 没有自己记账时兜底（避免重复计数）
        if (!res.__ledgerDone) {
          onCall({
            journeyId: params.journeyId ?? null,
            taskId: params.taskId ?? null,
            encounterId: params.encounterId ?? null,
            operationId: params.operationId ?? null,
            operationKind: params.op,
            attempt: (params.budget && params.budget.allowed === false) ? null : 1,
            kind: params.op,
            provider: label,
            model: res.meta?.model || (typeof adapter.getConfig === 'function' ? adapter.getConfig().model : null),
            usage: res.meta?.usage || null,
            latencyMs: res.meta?.latencyMs ?? 0,
            status: res.ok ? 'ok' : 'error',
            error: res.ok ? null : (res.error || 'unknown'),
            now: params.now ?? clock.now()
          });
        }
        return res;
      }
    };
    return wrapped;
  }

  function withJevLedger(adapter, { label }) {
    if (!adapter) return adapter;
    if (adapter.__ledgerWrapped) return adapter;
    const wrapped = {
      ...adapter,
      __ledgerWrapped: true,
      __label: label,
      judge: async (params) => {
        const res = await adapter.judge(params);
        onCall({
          journeyId: params.journeyId ?? null,
          taskId: params.taskId ?? null,
          encounterId: params.encounterId ?? null,
          operationId: params.operationId ?? null,
          operationKind: params.op,
          attempt: (params.budget && params.budget.allowed === false) ? null : 1,
          kind: params.op,
          provider: label,
          model: res.model || (typeof adapter.getConfig === 'function' ? adapter.getConfig().model : null),
          usage: res.usage || null,
          latencyMs: res.latencyMs ?? 0,
          status: res.available ? 'ok' : 'error',
          error: res.available ? null : (res.reason || 'unavailable'),
          now: params.now ?? clock.now()
        });
        return res;
      }
    };
    return wrapped;
  }

  const textModel = opts.textModel
    ? withLedger(opts.textModel, { label: 'injected' })
    : createTextModel({ clock, onCall });
  const jev = opts.jev
    ? withJevLedger(opts.jev, { label: 'injected' })
    : createJev({ clock, onCall });
  const image = opts.image || createImageAdapter({
    imageDir: require('node:path').join(REPO_ROOT, 'renderer', 'assets', 'images'),
    clock, onCall, logger
  });

  const orchestrator = createOrchestrator({ store, clock, textModel, jev, image, logger });
  const scheduler = createScheduler({ store, clock, orchestrator, logger });

  const commands = {
    release: createReleaseCommand({ store, clock }),
    replyToSignal: createReplyCommand({ store, clock }),
    setTone: createToneCommand({ store, clock }),
    endJourney: createEndCommand({ store, clock })
  };

  const queries = createJourneyQueries({ store, clock });

  let timer = null;
  let closed = false;

  return {
    store, clock, textModel, jev, image,
    orchestrator, scheduler, commands, queries,
    guards,
    meta: {
      orchestratorVersion: ORCHESTRATOR_VERSION,
      dbPath: dbOpened ? store.getDbPath() : null,
      dbOpened,
      mode: opts.mode || 'production'
    },

    /** 启动后台调度（由 start 入口显式调用，不由导入触发） */
    startScheduler(intervalMs) {
      if (closed) throw new Error('runtime closed');
      if (timer) return timer;
      timer = scheduler.start(intervalMs);
      return timer;
    },

    /** 释放资源：停 timer、关 DB。重复调用安全 */
    async stop() {
      if (closed) return;
      closed = true;
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      if (dbOpened) {
        store.closeDb();
        dbOpened = false;
      }
    },

    get closed() { return closed; }
  };
}

module.exports = { createRuntime, ORCHESTRATOR_VERSION };
