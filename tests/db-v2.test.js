// DB 原语测试：状态版本守卫、任务租约、一次性提交、消息语义
const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const { createWorld } = require('./helpers/world');

let world;
beforeEach(() => { world = createWorld({ tag: 'db' }); });

test('updateJourney 乐观锁：expected 不匹配则更新失败', () => {
  const j = world.db.createJourney({ id: 'J1', creatureId: 'C1', ownerKey: 'o', species: 'koi', water: 'xihu', feeling: 'f', tone: 'balanced', now: world.now() });
  world.db.updateJourney('J1', { state_version: 1 });
  // 用旧版本号做条件 → 失败
  assert.equal(world.db.updateJourney('J1', { goal: 'x' }, { state_version: 0 }), false);
  assert.equal(world.db.getJourney('J1').goal, null);
  // 用当前版本号 → 成功
  assert.equal(world.db.updateJourney('J1', { goal: 'x' }, { state_version: 1 }), true);
  assert.equal(world.db.getJourney('J1').goal, 'x');
});

test('encounter 一次性提交：decide/attachSupply/freeze 均只能成功一次', () => {
  const now = world.now();
  world.db.createJourney({ id: 'J2', creatureId: 'C2', ownerKey: 'o', species: 'koi', water: 'xihu', feeling: 'f', tone: 'balanced', now });
  world.db.insertEncounter({ id: 'E1', journeyId: 'J2', seq: 1, proposal: { actions: [] }, factsVersion: 0, stateVersion: 0, now });
  assert.equal(world.db.attachSupply('E1', 'MSG-x', now), false, 'cannot supply before signal');
  assert.equal(world.db.freezeEncounterSignal('E1', { messageId: 'MSG-s', dueAt: now + 1000, now }), true);
  assert.equal(world.db.freezeEncounterSignal('E1', { messageId: 'MSG-s2', dueAt: now + 2000, now }), false, 'signal frozen once');
  assert.equal(world.db.attachSupply('E1', 'MSG-y', now), true);
  assert.equal(world.db.attachSupply('E1', 'MSG-z', now), false, 'supply slot taken');
  assert.equal(world.db.decideEncounter('E1', { action: 'a1', source: 'jev', now }), true);
  assert.equal(world.db.decideEncounter('E1', { action: 'a2', source: 'jev', now }), false, 'decision final');
  assert.equal(world.db.resolveEncounter('E1', { outcome: {}, stateVersion: 1, now }), true);
  assert.equal(world.db.resolveEncounter('E1', { outcome: {}, stateVersion: 2, now }), false);
});

test('任务租约与取消：pending→leased→done；cancel 清空 open 任务', () => {
  const now = world.now();
  world.db.createJourney({ id: 'J3', creatureId: 'C3', ownerKey: 'o', species: 'koi', water: 'xihu', feeling: 'f', tone: 'balanced', now });
  world.db.insertTask({ id: 'T1', journeyId: 'J3', kind: 'opening', dueAt: now, now });
  world.db.insertTask({ id: 'T2', journeyId: 'J3', kind: 'decide', dueAt: now + 3600e3, now });
  assert.equal(world.db.countOpenTasks('J3'), 2);
  const claimed = world.db.claimDueTasks(now, { leaseMs: 60e3 });
  assert.equal(claimed.length, 1, 'only due task claimed');
  assert.equal(claimed[0].id, 'T1');
  world.db.completeTask('T1', now);
  assert.equal(world.db.getTask('T1').status, 'done');
  world.db.cancelTasksForJourney('J3', now);
  assert.equal(world.db.countOpenTasks('J3'), 0);
  assert.equal(world.db.getTask('T2').status, 'cancelled');
});

test('accelerateTask 只提前未来的任务', () => {
  const now = world.now();
  world.db.createJourney({ id: 'J4', creatureId: 'C4', ownerKey: 'o', species: 'koi', water: 'xihu', feeling: 'f', tone: 'balanced', now });
  world.db.insertTask({ id: 'T3', journeyId: 'J4', kind: 'decide', dueAt: now + 3600e3, now });
  assert.equal(world.db.accelerateTask('J4', 'decide', now + 60e3, now), true);
  assert.equal(world.db.getTask('T3').due_at, now + 60e3);
  assert.equal(world.db.accelerateTask('J4', 'decide', now + 90e3, now), false, 'never delays');
});

test('消息：sent_at 排序 + lastUserFacingAt 只统计生物来信', () => {
  const now = world.now();
  world.db.createJourney({ id: 'J5', creatureId: 'C5', ownerKey: 'o', species: 'koi', water: 'xihu', feeling: 'f', tone: 'balanced', now });
  world.db.insertMessage({ id: 'M1', journeyId: 'J5', kind: 'letter', text: 'a', sentAt: now + 100, now });
  world.db.insertMessage({ id: 'M2', journeyId: 'J5', kind: 'system', text: 'b', sentAt: now + 500, now });
  world.db.insertMessage({ id: 'M3', journeyId: 'J5', kind: 'signal', text: 'c', sentAt: now + 300, now });
  const msgs = world.db.getMessages('J5').map(m => m.id);
  assert.deepEqual(msgs, ['M1', 'M3', 'M2'], 'ordered by sent_at');
  assert.equal(world.db.lastUserFacingAt('J5'), now + 300, 'system excluded from creature contact anchor');
});

test('模型调用台账按旅程计数', () => {
  const now = world.now();
  world.db.createJourney({ id: 'J6', creatureId: 'C6', ownerKey: 'o', species: 'koi', water: 'xihu', feeling: 'f', tone: 'balanced', now });
  world.db.recordModelCall({ journeyId: 'J6', kind: 'director_opening', status: 'ok', model: 'm', usage: { input_tokens: 1 }, now });
  world.db.recordModelCall({ journeyId: 'J6', kind: 'jev_decide', status: 'error', error: 'x', now });
  assert.equal(world.db.countModelCalls('J6'), 2);
  const calls = world.db.getModelCalls('J6');
  assert.equal(calls[1].status, 'error');
});
