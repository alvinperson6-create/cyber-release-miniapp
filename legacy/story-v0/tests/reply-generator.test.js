// 离线边界测试：统一生成编排的入口行为（幂等、冻结、并发去重、补图不重写）
// 在 require reply-generator 之前打桩（其对 ai/story-pipeline/flags 为加载期解构）
const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cyber-release-rg-'));
process.env.DB_PATH = path.join(tmp, 'test.db');
process.env.JOURNEY_ENABLED = '0';

const ai = require('../server/ai');
const pipeline = require('../server/story-pipeline');
const flags = require('../server/flags');
const { makeDestinyJson } = require('./helpers/destiny-fixture');

// 打桩（在加载 reply-generator 前完成）；用可替换的委托，便于单测内改行为
let pipelineCalls = 0;
let imageCalls = 0;
let stubImpl = async () => {
  pipelineCalls += 1;
  return {
    destiny: makeDestinyJson({ textPrefix: `版本${pipelineCalls}` }),
    meta: { status: 'accepted', pipelineVersion: 'story-pipeline-v1', notes: [], repairs: [], situation: { supported: [] }, semantics: null, generation: { calls: 1 }, judging: { calls: 2 }, totalLatencyMs: 5, journeyApplied: false }
  };
};
pipeline.createStoryForRecord = (p) => stubImpl(p);
ai.generateReplyImage = async () => { imageCalls += 1; return `/images/test-${imageCalls}.png`; };
flags.journeyEnabled = () => false;

const db = require('../server/db');
db.initDb();
const { ensureStoryAndReply } = require('../server/reply-generator');

let seq = 100;
function makeRecord(overrides = {}) {
  const id = `CRSB-RG-${String(seq++).padStart(4, '0')}`;
  const rec = {
    id, openid: 'rg-tester', creature: 'koi', water: 'xihu', feeling: '测试烦恼',
    feedback_label: '24 小时后', sign: 's', created_at: Date.now(), reply_at: Date.now() + 3600e3,
    ...overrides
  };
  db.insertRecord(rec);
  return db.getRecordById(id);
}

beforeEach(() => { /* 状态通过独立记录 ID 隔离 */ });

test('新记录：走统一编排 → 落库 semantic_status → 回信取自第4集 → 冻结', async () => {
  const rec = makeRecord();
  const reply = await ensureStoryAndReply(rec);
  assert.match(reply.text, /版本1/);
  assert.equal(reply.image, '/images/test-1.png');
  const d = db.getDestinyByRecordId(rec.id);
  assert.equal(d.semanticStatus, 'accepted');
  assert.ok(d.frozenAt > 0);
  assert.deepEqual(d.unlockedIndices, [0]);
  const row = db.getRecordById(rec.id);
  assert.equal(row.reply_text, reply.text);
  assert.ok(row.reply_created_at > 0);
  assert.equal(pipelineCalls, 1);
});

test('重复调用：已有冻结故事 → 不重新生成（幂等）', async () => {
  const rec = makeRecord();
  const r1 = await ensureStoryAndReply(rec);
  const before = pipelineCalls;
  const r2 = await ensureStoryAndReply(db.getRecordById(rec.id));
  assert.equal(pipelineCalls, before);
  assert.equal(r2.text, r1.text); // 同一已接受版本
});

test('重复调用：已回信且有图 → 直接返回，不触发生成与图片', async () => {
  const rec = makeRecord();
  await ensureStoryAndReply(rec);
  const beforeP = pipelineCalls, beforeI = imageCalls;
  const reply = await ensureStoryAndReply(db.getRecordById(rec.id));
  assert.equal(pipelineCalls, beforeP);
  assert.equal(imageCalls, beforeI);
  assert.match(reply.text, /版本/);
});

test('已回信但缺图：只补图，不重写故事', async () => {
  const rec = makeRecord({ reply_bg: 'g', reply_emoji: '🐟', reply_text: '已存在的回信', reply_image: null, created_at: Date.now() - 7200e3, reply_at: Date.now() - 3600e3 });
  const beforeP = pipelineCalls;
  const reply = await ensureStoryAndReply(rec);
  assert.equal(pipelineCalls, beforeP); // 无重新生成
  assert.ok(reply.image);
  assert.equal(reply.text, '已存在的回信');
  const row = db.getRecordById(rec.id);
  assert.equal(row.reply_image, reply.image);
});

test('并发去重：同记录并发调用只生成一次', async () => {
  const rec = makeRecord();
  const before = pipelineCalls;
  const [a, b] = await Promise.all([ensureStoryAndReply(rec), ensureStoryAndReply(rec)]);
  assert.equal(pipelineCalls, before + 1);
  assert.equal(a.text, b.text);
});

test('降级故事仍可派生回信，但 semantic_status 如实为 degraded', async () => {
  const rec = makeRecord();
  stubImpl = async () => {
    pipelineCalls += 1;
    return {
      destiny: makeDestinyJson({ textPrefix: '降级版' }),
      meta: { status: 'degraded', notes: ['修复后仍有失败维度：行为改变'], repairs: [{ kind: 'semantic', result: 'applied_still_failing' }], situation: { supported: [] }, semantics: { failures: [{ id: 'behavior_change' }] }, generation: { calls: 2 }, judging: { calls: 2 }, totalLatencyMs: 9, journeyApplied: false, pipelineVersion: 'story-pipeline-v1' }
    };
  };
  const reply = await ensureStoryAndReply(rec);
  assert.match(reply.text, /降级版/);
  const d = db.getDestinyByRecordId(rec.id);
  assert.equal(d.semanticStatus, 'degraded');
});
