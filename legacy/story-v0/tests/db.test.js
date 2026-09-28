// 离线边界测试：数据库（独立测试库、幂等写入、冻结保护、解锁不被重置）
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cyber-release-test-'));
process.env.DB_PATH = path.join(tmp, 'test.db');

const db = require('../server/db');
db.initDb();

const RECORD = {
  id: 'CRSB-TEST-0001',
  openid: 'tester',
  creature: 'koi',
  water: 'xihu',
  feeling: '测试烦恼',
  feedback_label: '24 小时后',
  sign: 'sign',
  created_at: Date.now(),
  reply_at: Date.now() + 3600e3
};

function dstPayload(overrides = {}) {
  return {
    id: `DST-${RECORD.id}`,
    recordId: RECORD.id,
    openid: RECORD.openid,
    segments: [{ title: 't', text: 'x', emoji: '🐟' }],
    location: '西湖断桥',
    visual: null,
    visualForImage: { style: 's', subject: 'j', place: 'p' },
    reply: '回信',
    ending: '结局',
    semanticStatus: 'accepted',
    judgeMeta: { pipelineVersion: 'story-pipeline-v1' },
    contractMeta: { contractVersion: 'situation-contract-v1' },
    ...overrides
  };
}

test('DB：insertDestinyOnce 幂等 —— 第二次插入不生效', () => {
  db.insertRecord(RECORD);
  assert.equal(db.insertDestinyOnce(dstPayload()), true);
  assert.equal(db.insertDestinyOnce(dstPayload({ semanticStatus: 'repaired' })), false);
  const d = db.getDestinyByRecordId(RECORD.id);
  assert.equal(d.semanticStatus, 'accepted'); // 未被覆盖
  assert.deepEqual(d.unlockedIndices, [0]);
});

test('DB：解锁状态在冲突写入时不被重置（修复旧 UPSERT 缺陷）', () => {
  db.updateDestinyUnlocked(RECORD.id, [0, 1, 2]);
  db.insertDestiny(dstPayload({ segments: [{ title: '新', text: '新', emoji: '🐟' }] }));
  const d = db.getDestinyByRecordId(RECORD.id);
  assert.deepEqual(d.unlockedIndices, [0, 1, 2]); // 旧实现会被重置为 [0]
});

test('DB：冻结后 insertDestiny 不覆盖故事内容', () => {
  db.freezeDestiny(RECORD.id);
  db.insertDestiny(dstPayload({ location: '被篡改的地点', semanticStatus: 'degraded' }));
  const d = db.getDestinyByRecordId(RECORD.id);
  assert.equal(d.location, '西湖断桥');
  assert.equal(d.semanticStatus, 'accepted');
  assert.ok(d.frozenAt > 0);
});

test('DB：judge_meta / contract_meta 读写', () => {
  const d = db.getDestinyByRecordId(RECORD.id);
  assert.equal(d.judgeMeta.pipelineVersion, 'story-pipeline-v1');
  assert.equal(d.contractMeta.contractVersion, 'situation-contract-v1');
});

test('DB：getPendingReplies 只取到期未生成且非生成中的记录', () => {
  const now = Date.now();
  db.insertRecord({ ...RECORD, id: 'CRSB-TEST-0002', reply_at: now - 1000 }); // 到期、无回信
  db.insertRecord({ ...RECORD, id: 'CRSB-TEST-0003', reply_at: now + 86400e3 }); // 未到期
  const ids = db.getPendingReplies(10, 0).map(r => r.id);
  assert.ok(ids.includes('CRSB-TEST-0002'));
  assert.ok(!ids.includes('CRSB-TEST-0003'));
  db.markReplyGenerating('CRSB-TEST-0002');
  assert.ok(!db.getPendingReplies(10, 0).map(r => r.id).includes('CRSB-TEST-0002'));
  db.clearReplyGenerating('CRSB-TEST-0002');
});

test('DB：journeys 表已就绪（第二阶段）', () => {
  // better-sqlite3 安装在 server/node_modules 下，直接导出构造函数
  const Database = require(require.resolve('better-sqlite3', { paths: [path.join(__dirname, '..', 'server')] }));
  const d2 = new Database(process.env.DB_PATH, { readonly: true });
  const t = d2.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='journeys'").get();
  assert.equal(t.name, 'journeys');
  d2.close();
});
