// 存储适配层：乐观锁、条件提交、租约条件、幂等与迁移
//
// 这一层是所有"竞态护栏"的物理基础，因此逐条覆盖写路径：
// 命名参数绑定、条件更新影响行数、租约持有者、幂等域、迁移可重入。

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createStore, resolveDbPath, LEGACY_DB_PATH, SCHEMA_VERSION } = require('../serving/adapters/store');

function newStore(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `cr-store-${tag}-`));
  const store = createStore({ path: path.join(dir, 'test.db') });
  store.initDb();
  return store;
}

const T0 = 1750000000000;

test('迁移可重入：重复执行不报错，user_version 停在目标版本', () => {
  const store = newStore('mig');
  try {
    assert.equal(store.currentVersion(store.getDb()), SCHEMA_VERSION);
    const before = store.getDb().prepare(
      `SELECT COUNT(*) c FROM sqlite_master WHERE type='table'`
    ).get().c;
    // 再跑一次：没有任何迁移需要应用
    const r = store.runMigrations(store.getDb());
    assert.deepEqual(r.applied, [], '第二次不应重复应用迁移');
    const after = store.getDb().prepare(
      `SELECT COUNT(*) c FROM sqlite_master WHERE type='table'`
    ).get().c;
    assert.equal(after, before, '表数量不变');
  } finally { store.closeDb(); }
});

test('迁移保留历史数据：旧库加新表，旧行数不变', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-legacy-'));
  const file = path.join(dir, 'legacy.db');
  const old = createStore({ path: file });
  old.initDb();
  // 造一张"历史表"模拟旧产品残留
  old.getDb().exec(`CREATE TABLE IF NOT EXISTS records (id INTEGER PRIMARY KEY, note TEXT)`);
  old.getDb().prepare(`INSERT INTO records (note) VALUES (?)`).run('旧四集记录');
  old.closeDb();

  const store = createStore({ path: file });
  store.initDb();
  try {
    assert.equal(store.getDb().prepare('SELECT COUNT(*) c FROM records').get().c, 1, '历史记录保留');
    assert.ok(store.getDb().prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='journeys'`
    ).get(), '新表已创建');
  } finally { store.closeDb(); }
});

test('updateJourney 乐观锁：expected 不匹配则更新失败', () => {
  const store = newStore('lock');
  try {
    const c = store.createCreature({ id: 'CRT1', ownerKey: 'A', species: 'koi', now: T0 });
    store.createJourney({ id: 'J1', creatureId: c.id, ownerKey: 'A', species: 'koi', water: 'xihu', feeling: '烦', tone: 'balanced', now: T0 });

    // 首次提交推进状态版本
    assert.equal(store.updateJourney('J1', { goal: 'g', state_version: 1 }, { status: 'preparing', state_version: 0 }), true);
    assert.equal(store.getJourney('J1').state_version, 1);

    // 用过期版本再更新必须失败（不得覆盖新状态）
    assert.equal(store.updateJourney('J1', { goal: 'g2' }, { status: 'preparing', state_version: 0 }), false);
    assert.equal(store.getJourney('J1').goal, 'g', '失败时不写入');

    // expected 为 null 时校验 IS NULL
    assert.equal(store.updateJourney('J1', { pause_reason: 'p' }, { goal: null }), false, 'goal 非 null 时不应匹配 IS NULL');
  } finally { store.closeDb(); }
});

test('遭遇一次性提交：freezeSignal / attachSupply / decide 各自只能成功一次', () => {
  const store = newStore('once');
  try {
    const c = store.createCreature({ id: 'C', ownerKey: 'A', species: 'koi', now: T0 });
    store.createJourney({ id: 'J', creatureId: c.id, ownerKey: 'A', species: 'koi', water: 'xihu', feeling: '烦', tone: 'balanced', now: T0 });
    store.insertEncounter({
      id: 'E1', journeyId: 'J', seq: 1,
      proposal: { title: 't', actions: [{ id: 'a1', label: 'x', cost: 'y' }], mechanism_summary: {} },
      factsVersion: 0, stateVersion: 0, now: T0
    });

    assert.equal(store.freezeEncounterSignal('E1', { messageId: 'M1', dueAt: T0 + 1000, now: T0 }), true);
    assert.equal(store.freezeEncounterSignal('E1', { messageId: 'M2', dueAt: T0 + 2000, now: T0 }), false, '不能寄第二次');

    assert.equal(store.attachSupply('E1', 'MR1', T0), true);
    assert.equal(store.attachSupply('E1', 'MR2', T0), false, '补给位只能被抢一次');

    assert.equal(store.decideEncounter('E1', { action: 'a1', source: 'jev', now: T0 }), true);
    assert.equal(store.decideEncounter('E1', { action: 'a2', source: 'jev', now: T0 }), false, '决策不可改写');
  } finally { store.closeDb(); }
});

test('decideEncounter 快照护栏：补给位变化后判 stale，不静默吞掉新补给', () => {
  const store = newStore('snap');
  try {
    const c = store.createCreature({ id: 'C', ownerKey: 'A', species: 'koi', now: T0 });
    store.createJourney({ id: 'J', creatureId: c.id, ownerKey: 'A', species: 'koi', water: 'xihu', feeling: '烦', tone: 'balanced', now: T0 });
    store.insertEncounter({
      id: 'E1', journeyId: 'J', seq: 1,
      proposal: { title: 't', actions: [{ id: 'a1', label: 'x', cost: 'y' }], mechanism_summary: {} },
      factsVersion: 0, stateVersion: 0, now: T0
    });
    store.freezeEncounterSignal('E1', { messageId: 'M1', dueAt: T0 + 1000, now: T0 });

    // 决策在"无补给"时生成；随后用户按时补给到达
    store.attachSupply('E1', 'MR1', T0);

    // 用旧快照（无补给）提交 → 必须失败，不能悄悄吞掉新补给
    const stale = store.decideEncounter('E1', { action: 'a1', source: 'jev', now: T0, expectSupply: null });
    assert.equal(stale, false, '快照已过期必须失败');
    assert.equal(store.getEncounter('E1').status, 'signal_sent', '未落决策');

    // 用与当前一致的新快照 → 成功
    const ok = store.decideEncounter('E1', { action: 'a1', source: 'jev', now: T0, expectSupply: 'MR1' });
    assert.equal(ok, true);
    assert.equal(store.getEncounter('E1').status, 'decided');
  } finally { store.closeDb(); }
});

test('任务租约条件：旧持有者的完成/重试/失败都不能覆盖新持有者', () => {
  const store = newStore('lease');
  try {
    const c = store.createCreature({ id: 'C', ownerKey: 'A', species: 'koi', now: T0 });
    store.createJourney({ id: 'J', creatureId: c.id, ownerKey: 'A', species: 'koi', water: 'xihu', feeling: '烦', tone: 'balanced', now: T0 });
    store.insertTask({ id: 'T1', journeyId: 'J', kind: 'opening', dueAt: T0, payload: {}, now: T0 });

    const [claimed] = store.claimDueTasks(T0, { limit: 1, leaseMs: 1000 });
    assert.equal(claimed.id, 'T1');
    const oldLease = claimed.lease_key;

    // 租约过期被回收，另一个 worker 接手
    store.recoverExpiredLeases(T0 + 2000);
    const [reclaimed] = store.claimDueTasks(T0 + 2000, { limit: 1, leaseMs: 1000 });
    const newLease = reclaimed.lease_key;
    assert.notEqual(newLease, oldLease, '新持有者有不同的租约键');

    // 旧 worker 迟到收尾：三种动作全部影响 0 行
    assert.equal(store.completeTask('T1', T0 + 3000, oldLease), false, '旧持有者不能完成任务');
    assert.equal(store.rescheduleTask('T1', T0 + 4000, T0 + 3000, oldLease), false, '旧持有者不能重排');
    assert.equal(store.failTask('T1', 'boom', T0 + 3000, oldLease), false, '旧持有者不能标失败');

    // 状态仍属于新持有者
    const t = store.getTask('T1');
    assert.equal(t.status, 'leased');
    assert.equal(t.lease_key, newLease);

    // 新持有者可以正常收尾
    assert.equal(store.completeTask('T1', T0 + 3000, newLease), true);
    assert.equal(store.getTask('T1').status, 'done');
  } finally { store.closeDb(); }
});

test('defer 不消耗错误重试次数：reschedule 不动 attempts', () => {
  const store = newStore('defer');
  try {
    const c = store.createCreature({ id: 'C', ownerKey: 'A', species: 'koi', now: T0 });
    store.createJourney({ id: 'J', creatureId: c.id, ownerKey: 'A', species: 'koi', water: 'xihu', feeling: '烦', tone: 'balanced', now: T0 });
    store.insertTask({ id: 'T1', journeyId: 'J', kind: 'decide', dueAt: T0, payload: {}, now: T0 });

    let claimed = store.claimDueTasks(T0, { limit: 1, leaseMs: 10 })[0];
    const attemptsAfterFirstClaim = claimed.attempts;

    // 连续 5 轮"正常等待 → 重新认领"：每轮 lease 计数 +1，但 defer 本身不加错误次数
    for (let i = 1; i <= 5; i++) {
      const t = T0 + i * 1000;
      assert.equal(store.rescheduleTask('T1', t, t, claimed.lease_key), true, '正常等待应成功重排');
      claimed = store.claimDueTasks(t, { limit: 1, leaseMs: 10 })[0];
      assert.ok(claimed, '应能重新认领');
    }

    // attempts 只随认领次数增长（6 次认领 = 6），没有被 defer 额外放大
    assert.equal(claimed.attempts, attemptsAfterFirstClaim + 5);
    assert.equal(store.getTask('T1').status, 'leased');
    // 没有 last_error：defer 不是错误
    assert.equal(store.getTask('T1').last_error, null);
  } finally { store.closeDb(); }
});

test('任务去重：同 (journey, kind, goal) 只排一次', () => {
  const store = newStore('dedup');
  try {
    const c = store.createCreature({ id: 'C', ownerKey: 'A', species: 'koi', now: T0 });
    store.createJourney({ id: 'J', creatureId: c.id, ownerKey: 'A', species: 'koi', water: 'xihu', feeling: '烦', tone: 'balanced', now: T0 });

    const first = store.scheduleTaskOnce({ id: 'T1', journeyId: 'J', kind: 'contact', dueAt: T0, payload: {}, goalKey: 'g1', now: T0 });
    const second = store.scheduleTaskOnce({ id: 'T2', journeyId: 'J', kind: 'contact', dueAt: T0, payload: {}, goalKey: 'g1', now: T0 });
    assert.equal(first, true);
    assert.equal(second, false, '同一目标不重复排程');

    const different = store.scheduleTaskOnce({ id: 'T3', journeyId: 'J', kind: 'contact', dueAt: T0, payload: {}, goalKey: 'g2', now: T0 });
    assert.equal(different, true, '不同目标是新排程');

    const count = store.getDb().prepare('SELECT COUNT(*) c FROM tasks WHERE journey_id = ?').get('J').c;
    assert.equal(count, 2);
  } finally { store.closeDb(); }
});

test('命令幂等按 (owner, operation, requestId) 分域', () => {
  const store = newStore('idem');
  try {
    const db = store.getDb();
    const result = { ok: true, journeyId: 'J1' };

    store.recordCommandResult(db, {
      ownerKey: 'A', operation: 'release', requestId: 'req-000001',
      fingerprint: 'release:species=koi', result, now: T0
    });

    // 同 owner 同键同载荷 → 命中
    const hitA = store.readCommandResult({ ownerKey: 'A', operation: 'release', requestId: 'req-000001', fingerprint: 'release:species=koi' });
    assert.equal(hitA.hit, true);
    assert.deepEqual(hitA.result, result);

    // 同键异载荷 → 冲突
    const conflict = store.readCommandResult({ ownerKey: 'A', operation: 'release', requestId: 'req-000001', fingerprint: 'release:species=turtle' });
    assert.equal(conflict.conflict, true);

    // 不同 owner 域互不串用
    const otherOwner = store.readCommandResult({ ownerKey: 'B', operation: 'release', requestId: 'req-000001', fingerprint: 'release:species=koi' });
    assert.equal(otherOwner.hit, false);

    // 不同 operation 域互不串用
    const otherOp = store.readCommandResult({ ownerKey: 'A', operation: 'endJourney', requestId: 'req-000001', fingerprint: 'release:species=koi' });
    assert.equal(otherOp.hit, false);
  } finally { store.closeDb(); }
});

test('业务 operation 台账：唯一约束做原子去重', () => {
  const store = newStore('op');
  try {
    assert.equal(store.claimOperation({ operationId: 'op1', journeyId: 'J', kind: 'letter', now: T0 }), 'applied');
    assert.equal(store.claimOperation({ operationId: 'op1', journeyId: 'J', kind: 'letter', now: T0 }), 'already_applied');
    assert.equal(store.hasOperation('op1'), true);
  } finally { store.closeDb(); }
});

test('模型台账区分逻辑操作与 transport attempt，允许历史缺值', () => {
  const store = newStore('ledger');
  try {
    store.recordModelCall({ kind: 'opening', status: 'ok', now: T0, provider: 'p', model: 'm' });
    store.recordModelCall({
      journeyId: 'J', taskId: 'T', encounterId: 'E', operationId: 'op1',
      operationKind: 'settlement', attempt: 2, kind: 'settlement', status: 'error', error: 'boom', now: T0
    });
    store.recordModelCall({ kind: 'settlement', status: 'budget_denied', error: 'budget_exhausted', now: T0 });

    const all = store.getDb().prepare('SELECT * FROM model_calls ORDER BY id').all();
    assert.equal(all.length, 3);
    assert.equal(all[0].journey_id, null, '历史/无归属调用允许缺值');
    assert.equal(all[1].attempt, 2, 'transport attempt 单独记录');
    assert.equal(all[2].status, 'budget_denied', '无网络调用的预算拒绝单独状态');
  } finally { store.closeDb(); }
});

test('数据路径锚定：DB_PATH 优先，否则落在历史位置', () => {
  const prev = process.env.DB_PATH;
  try {
    process.env.DB_PATH = '/tmp/abc.db';
    assert.equal(resolveDbPath(), '/tmp/abc.db');
    delete process.env.DB_PATH;
    assert.equal(resolveDbPath(), LEGACY_DB_PATH);
    assert.ok(LEGACY_DB_PATH.endsWith(path.join('server', 'data.db')), '默认不随代码搬迁漂移');
  } finally {
    if (prev == null) delete process.env.DB_PATH; else process.env.DB_PATH = prev;
  }
});
