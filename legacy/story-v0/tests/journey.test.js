// 离线边界测试：生物事件旅程（合法动作、确定性迁移、留言竞争、冻结、幂等重放）
const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cyber-release-journey-'));
process.env.DB_PATH = path.join(tmp, 'test.db');
process.env.JOURNEY_TIME_SCALE = '1';

// 先打桩再 require（journey.js 对 jev/flags 为加载期解构）
const jev = require('../server/jev');
let jevOn = false;
let jevStub = null;
let jevCalls = 0;
jev.isJeVEnabled = () => jevOn;
jev.jevJudge = async (state, questions) => {
  jevCalls += 1;
  if (!jevStub) throw new Error('jevStub 未配置');
  return jevStub(state, questions);
};
const flags = require('../server/flags');
let journeyOn = true;
flags.journeyEnabled = () => journeyOn;

const db = require('../server/db');
db.initDb();
const journey = require('../server/journey');

let seq = 0;
const T0 = 1750000000000;
function makeRecord({ waitMs = 40 * 60000, createdAt = T0 + (seq++) * 100000 } = {}) {
  const id = `CRSB-J-${String(seq).padStart(4, '0')}`;
  db.insertRecord({
    id, openid: 'j-tester', creature: 'koi', water: 'xihu', feeling: '谁找我帮忙我都答应，最后只有我的事情没做完',
    feedback_label: 'test', sign: 's', created_at: createdAt, reply_at: createdAt + waitMs
  });
  return db.getRecordById(id);
}

beforeEach(() => { jevOn = false; jevStub = null; });

test('旅程：规则回退（无 JEV）→ compliant 全部答应，账本完整', async () => {
  const rec = makeRecord();
  journey.createJourney(rec);
  // step = waitMs/4 = 10s；事件在 +10s/+20s/+30s
  let v = await journey.advanceJourney(rec.id, { now: rec.created_at + 450001 });
  assert.equal(v.events.length, 1);
  assert.equal(v.events[0].action, '答应');
  v = await journey.advanceJourney(rec.id, { now: rec.created_at + 900001 });
  assert.equal(v.events.length, 2);
  v = await journey.advanceJourney(rec.id, { now: rec.created_at + 1350001 });
  assert.equal(v.events.length, 3);
  assert.equal(v.eventCursor, 3);
  assert.ok(v.events.every(e => e.action === '答应'));
});

test('旅程：时间未到不推进（惰性时间轴）', async () => {
  const rec = makeRecord();
  journey.createJourney(rec);
  const v = await journey.advanceJourney(rec.id, { now: rec.created_at + 100000 });
  assert.equal(v.events.length, 0);
  assert.equal(v.eventCursor, 0);
});

test('旅程：重放幂等 —— 同一时刻重复推进不产生新事件、不重问模型', async () => {
  const rec = makeRecord();
  journey.createJourney(rec);
  jevOn = true;
  jevStub = async (state, questions) => ({
    answers: { action: { type: 'choice', choice: '协商', probabilities: {} } },
    usage: {}, model: 'stub', latencyMs: 1
  });
  const v1 = await journey.advanceJourney(rec.id, { now: rec.created_at + 460000 });
  const calls = jevCalls;
  const v2 = await journey.advanceJourney(rec.id, { now: rec.created_at + 460000 });
  assert.equal(v2.events.length, v1.events.length);
  assert.equal(jevCalls, calls); // 重放零模型调用
  assert.equal(v2.events[0].actionSource, 'jev'); // 来源已落账本
});

test('旅程：留言授权拒绝 → 只影响留言之后的事件，历史事件不改写', async () => {
  const rec = makeRecord();
  journey.createJourney(rec);
  // 事件1：答应（compliant）
  let v = await journey.advanceJourney(rec.id, { now: rec.created_at + 450001 });
  assert.equal(v.events[0].action, '答应');
  // 留言（无 JEV → 关键词回退判定 permission_to_refuse）
  const msg = await journey.leaveMessage(rec.id, '这次你可以拒绝。');
  assert.equal(msg.ok, true);
  assert.equal(msg.intent, 'permission_to_refuse');
  // 事件2/3：拒绝
  v = await journey.advanceJourney(rec.id, { now: rec.created_at + 900001 });
  assert.equal(v.events[1].action, '拒绝');
  v = await journey.advanceJourney(rec.id, { now: rec.created_at + 1350001 });
  assert.equal(v.events[2].action, '拒绝');
  // 历史事件1未被改写
  assert.equal(v.events[0].action, '答应');
  assert.equal(v.tendency, 'assertive');
});

test('旅程：留言竞争 —— 已结束的旅程拒绝留言，过期留言不改历史', async () => {
  const rec = makeRecord();
  journey.createJourney(rec);
  // 推进全部事件并制造已回信事实（destiny 存在）
  await journey.advanceJourney(rec.id, { now: rec.created_at + 1500000 });
  db.insertDestinyOnce({
    id: `DST-${rec.id}`, recordId: rec.id, openid: rec.openid,
    segments: [{ title: 't', text: 'x', emoji: '🐟' }], location: 'x',
    visualForImage: {}, reply: 'r', ending: 'e', frozenAt: Date.now()
  });
  const v = await journey.advanceJourney(rec.id, { now: rec.created_at + 1510000 });
  assert.equal(v.terminalStatus, 'letter_frozen');
  const msg = await journey.leaveMessage(rec.id, '再拒绝一次');
  assert.equal(msg.ok, false);
  assert.equal(msg.code, 'journey_ended');
});

test('旅程：一词千金 —— 每轮只允许一条留言', async () => {
  const rec = makeRecord();
  journey.createJourney(rec);
  const m1 = await journey.leaveMessage(rec.id, '这次你可以拒绝。');
  assert.equal(m1.ok, true);
  const m2 = await journey.leaveMessage(rec.id, '换一句');
  assert.equal(m2.ok, false);
  assert.equal(m2.code, 'already_has_message');
});

test('旅程：无语义意图的留言如实记录为 no effect', async () => {
  const rec = makeRecord();
  journey.createJourney(rec);
  const m = await journey.leaveMessage(rec.id, '今天天气不错');
  assert.equal(m.ok, true);
  assert.equal(m.intent, 'other');
  assert.equal(m.effect, 'none');
  const v = await journey.advanceJourney(rec.id, { now: rec.created_at + 460000 });
  assert.equal(v.events[0].action, '答应'); // 倾向未变
});

test('旅程：buildJourneyContext 输出账本摘要与留言说明', async () => {
  const rec = makeRecord();
  journey.createJourney(rec);
  assert.equal(journey.buildJourneyContext(rec.id), null); // 无事件时为 null
  await journey.leaveMessage(rec.id, '这次你可以拒绝。');
  await journey.advanceJourney(rec.id, { now: rec.created_at + 1400000 });
  const ctx = journey.buildJourneyContext(rec.id);
  assert.ok(ctx.ledgerSummary.includes('螃蟹请代班'));
  assert.ok(ctx.ledgerSummary.includes('拒绝'));
  assert.ok(ctx.tendencyNote.includes('这次你可以拒绝'));
});

test('旅程：开关关闭 → 不推进、不留言', async () => {
  journeyOn = false;
  const rec = makeRecord();
  journey.createJourney(rec);
  assert.equal(await journey.advanceJourney(rec.id, { now: rec.created_at + 1500000 }), null);
  const m = await journey.leaveMessage(rec.id, 'hi');
  assert.equal(m.ok, false);
  assert.equal(m.code, 'journey_disabled');
  journeyOn = true;
});
