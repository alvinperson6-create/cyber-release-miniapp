const Database = require('better-sqlite3');
const path = require('path');
const { REPLY_POOL, SIGNS } = require('./data');

const DB_PATH = path.join(__dirname, 'data.db');
const DEMO_OPENID = 'demo_user_001';

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

function initDb() {
  db.prepare(`
    CREATE TABLE IF NOT EXISTS records (
      id TEXT PRIMARY KEY,
      openid TEXT NOT NULL,
      creature TEXT NOT NULL,
      water TEXT NOT NULL,
      feeling TEXT,
      feedback_label TEXT,
      sign TEXT,
      created_at INTEGER NOT NULL,
      reply_at INTEGER NOT NULL,
      reply_bg TEXT,
      reply_emoji TEXT,
      reply_text TEXT,
      reply_image TEXT,
      reply_created_at INTEGER
    )
  `).run();

  // 兼容旧数据库：新增 reply_image 字段
  try {
    db.prepare(`ALTER TABLE records ADD COLUMN reply_image TEXT`).run();
  } catch (e) {
    // 字段已存在则忽略
  }

  // 命运轨迹表：每条放生记录对应一段命运轨迹
  // segments: JSON 数组 [{title, text, emoji, bg}]
  // unlocked_indices: JSON 数组 [0,1,2,...] 已解锁的段索引（第 0 段默认免费）
  db.prepare(`
    CREATE TABLE IF NOT EXISTS destinies (
      id TEXT PRIMARY KEY,
      record_id TEXT NOT NULL UNIQUE,
      openid TEXT NOT NULL,
      segments TEXT NOT NULL,
      unlocked_indices TEXT NOT NULL DEFAULT '[0]',
      created_at INTEGER NOT NULL,
      FOREIGN KEY (record_id) REFERENCES records(id)
    )
  `).run();

  seedDemoData();
}

function seedDemoData() {
  const row = db.prepare('SELECT COUNT(*) AS c FROM records').get();
  if (row.c > 0) return;

  const now = Date.now();
  const HOUR = 60 * 60 * 1000;
  const DAY = 24 * HOUR;

  const demoRecords = [
    {
      id: 'CRSB-DEMO-0001',
      openid: DEMO_OPENID,
      creature: 'koi',
      water: 'xihu',
      feeling: '最近项目压力大，放一只锦鲤求点好运。',
      feedback_label: '24 小时后',
      sign: SIGNS.koi[0],
      created_at: now - 26 * HOUR,
      reply_at: now - 26 * HOUR + DAY,
      reply: REPLY_POOL[0]
    },
    {
      id: 'CRSB-DEMO-0002',
      openid: DEMO_OPENID,
      creature: 'turtle',
      water: 'mariana',
      feeling: '感觉自己太慢了，把焦虑沉到海底去吧。',
      feedback_label: '24 小时后',
      sign: SIGNS.turtle[0],
      created_at: now - 30 * 60 * 1000,
      reply_at: now - 30 * 60 * 1000 + DAY,
      reply: null
    },
    {
      id: 'CRSB-DEMO-0003',
      openid: DEMO_OPENID,
      creature: 'cloud',
      water: 'baikal',
      feeling: '脑子乱糟糟的，想让云朵替我飘一会儿。',
      feedback_label: '24 小时后',
      sign: SIGNS.cloud[0],
      created_at: now - 50 * HOUR,
      reply_at: now - 50 * HOUR + DAY,
      reply: REPLY_POOL[3]
    },
    {
      id: 'CRSB-DEMO-0004',
      openid: DEMO_OPENID,
      creature: 'koi',
      water: 'pacific',
      feeling: '祝自己一切顺利，放生积德。',
      feedback_label: '24 小时后',
      sign: SIGNS.koi[1],
      created_at: now - 96 * HOUR,
      reply_at: now - 96 * HOUR + DAY,
      reply: REPLY_POOL[5]
    }
  ];

  const insert = db.prepare(`
    INSERT INTO records (
      id, openid, creature, water, feeling, feedback_label, sign,
      created_at, reply_at, reply_bg, reply_emoji, reply_text, reply_created_at
    ) VALUES (
      @id, @openid, @creature, @water, @feeling, @feedback_label, @sign,
      @created_at, @reply_at, @reply_bg, @reply_emoji, @reply_text, @reply_created_at
    )
  `);

  const tx = db.transaction((records) => {
    for (const r of records) {
      insert.run({
        id: r.id,
        openid: r.openid,
        creature: r.creature,
        water: r.water,
        feeling: r.feeling,
        feedback_label: r.feedback_label,
        sign: r.sign,
        created_at: r.created_at,
        reply_at: r.reply_at,
        reply_bg: r.reply ? r.reply.bg : null,
        reply_emoji: r.reply ? r.reply.emoji : null,
        reply_text: r.reply ? r.reply.text : null,
        reply_created_at: r.reply ? r.reply_at : null
      });
    }
  });

  tx(demoRecords);

  // 为已回信的 demo 记录播种命运轨迹
  const demoDestinies = [
    {
      id: 'DST-CRSB-DEMO-0001',
      record_id: 'CRSB-DEMO-0001',
      openid: DEMO_OPENID,
      segments: [
        { title: '入水瞬间', text: '锦鲤从你的掌心滑进西湖，鳞片在晨光里闪了一下。它没有回头，但摆了摆尾巴，像是在说"放心"。', emoji: '🌿', bg: 'linear-gradient(135deg, #d4e8e2, #a9d2c5)' },
        { title: '顺流而下', text: '它穿过一片水草，遇见一群透明的小鱼。它们互相打了个照面，又各自游开。西湖的水比它想象的温柔。', emoji: '🌊', bg: 'linear-gradient(135deg, #c7dbe2, #9bc8bd)' },
        { title: '一次回望', text: '在断桥下面它停了一下。它想起你写"项目压力大"时的样子——它没法替你解决，但它决定替你记着，替你游得慢一点。', emoji: '🔥', bg: 'linear-gradient(135deg, #f9d8c9, #ed7d5b)' },
        { title: '准备回信', text: '它找到一块长满青苔的石头，靠着，开始想怎么把这一路的事讲给你听。回信已经在它嘴里成形了。', emoji: '✨', bg: 'linear-gradient(135deg, #e8d5f0, #c4a8d8)' }
      ],
      unlocked_indices: '[0,1]'  // 前两段已解锁
    },
    {
      id: 'DST-CRSB-DEMO-0003',
      record_id: 'CRSB-DEMO-0003',
      openid: DEMO_OPENID,
      segments: [
        { title: '升上天空', text: '云朵从你手心飘起来，越飘越高，最后停在贝加尔湖上空。它低头看了你一眼，然后被风推着走了。', emoji: '☁️', bg: 'linear-gradient(135deg, #c7dbe2, #9bc8bd)' },
        { title: '随风漂泊', text: '它路过一座雪山，又路过一片云。云和云之间互相点头，像在说"你也来啦"。它觉得自己轻了一点。', emoji: '🌙', bg: 'linear-gradient(135deg, #d1ecf1, #79c8d9)' },
        { title: '装下你的事', text: '它把你写下的"脑子乱糟糟的"装进自己身体里。装着装着，它发现自己变重了——但不是坏事，是那种被需要的重。', emoji: '✨', bg: 'linear-gradient(135deg, #e8d5f0, #c4a8d8)' },
        { title: '化作回信', text: '它飘回贝加尔湖上空，把自己拧了拧，拧出一封回信，轻轻丢向你的方向。', emoji: '🌙', bg: 'linear-gradient(135deg, #fff3cd, #ffd970)' }
      ],
      unlocked_indices: '[0]'  // 仅第一段已解锁
    },
    {
      id: 'DST-CRSB-DEMO-0004',
      record_id: 'CRSB-DEMO-0004',
      openid: DEMO_OPENID,
      segments: [
        { title: '入水瞬间', text: '锦鲤从你的掌心滑进太平洋，鳞片在正午的阳光里闪了一下。它没有回头，一头扎进了深蓝色的水里。', emoji: '🔥', bg: 'linear-gradient(135deg, #f9d8c9, #ed7d5b)' },
        { title: '顺流而下', text: '太平洋很大，它游了很久没见到边。遇到一群海豚，海豚问它去哪，它说"去给一个人写封信"。', emoji: '🌊', bg: 'linear-gradient(135deg, #d1ecf1, #79c8d9)' },
        { title: '一次回望', text: '在一片珊瑚礁它停了一下。它想起你写"放生积德"时的样子——它决定替你把这份善意带去更远的海域。', emoji: '☀️', bg: 'linear-gradient(135deg, #fff3cd, #ffd970)' },
        { title: '准备回信', text: '它找到一块温暖的礁石，靠着，开始想怎么把这一路的事讲给你听。回信已经在它嘴里成形了。', emoji: '✨', bg: 'linear-gradient(135deg, #e8d5f0, #c4a8d8)' }
      ],
      unlocked_indices: '[0,1,2,3]'  // 全部已解锁
    }
  ];

  const insertDst = db.prepare(`
    INSERT INTO destinies (id, record_id, openid, segments, unlocked_indices, created_at)
    VALUES (@id, @record_id, @openid, @segments, @unlocked_indices, @created_at)
  `);
  const txDst = db.transaction((items) => {
    for (const d of items) {
      insertDst.run({
        id: d.id,
        record_id: d.record_id,
        openid: d.openid,
        segments: JSON.stringify(d.segments),
        unlocked_indices: d.unlocked_indices,
        created_at: now
      });
    }
  });
  txDst(demoDestinies);
  console.log(`[db] Seeded ${demoRecords.length} demo records`);
}

function insertRecord(record) {
  const stmt = db.prepare(`
    INSERT INTO records (
      id, openid, creature, water, feeling, feedback_label, sign,
      created_at, reply_at, reply_bg, reply_emoji, reply_text, reply_image, reply_created_at
    ) VALUES (
      @id, @openid, @creature, @water, @feeling, @feedback_label, @sign,
      @created_at, @reply_at, @reply_bg, @reply_emoji, @reply_text, @reply_image, @reply_created_at
    )
  `);
  stmt.run({
    id: record.id,
    openid: record.openid,
    creature: record.creature,
    water: record.water,
    feeling: record.feeling,
    feedback_label: record.feedback_label,
    sign: record.sign,
    created_at: record.created_at,
    reply_at: record.reply_at,
    reply_bg: record.reply_bg ?? null,
    reply_emoji: record.reply_emoji ?? null,
    reply_text: record.reply_text ?? null,
    reply_image: record.reply_image ?? null,
    reply_created_at: record.reply_created_at ?? null
  });
}

function getRecordsByOpenid(openid) {
  return db.prepare(`
    SELECT * FROM records WHERE openid = ? ORDER BY created_at DESC
  `).all(openid);
}

function getRecordById(id) {
  return db.prepare(`SELECT * FROM records WHERE id = ?`).get(id);
}

function getPendingReplies() {
  const now = Date.now();
  return db.prepare(`
    SELECT * FROM records
    WHERE reply_at <= ? AND reply_text IS NULL
  `).all(now);
}

function updateReply(id, reply) {
  const now = Date.now();
  db.prepare(`
    UPDATE records
    SET reply_bg = ?, reply_emoji = ?, reply_text = ?, reply_image = ?, reply_created_at = ?
    WHERE id = ?
  `).run(reply.bg, reply.emoji, reply.text, reply.image || null, now, id);
}

function getStats(openid) {
  const total = db.prepare(`SELECT COUNT(*) AS c FROM records WHERE openid = ?`).get(openid).c;
  const replied = db.prepare(`SELECT COUNT(*) AS c FROM records WHERE openid = ? AND reply_text IS NOT NULL`).get(openid).c;
  const now = Date.now();
  const pending = db.prepare(`
    SELECT COUNT(*) AS c FROM records
    WHERE openid = ? AND reply_at <= ? AND reply_text IS NULL
  `).get(openid, now).c;
  return { total, pending, replied };
}

// ==================== 命运轨迹 ====================
function insertDestiny({ id, recordId, openid, segments }) {
  // 同一记录多次生成时直接覆盖，避免 UNIQUE constraint failed
  db.prepare(`
    INSERT INTO destinies (id, record_id, openid, segments, unlocked_indices, created_at)
    VALUES (?, ?, ?, ?, '[0]', ?)
    ON CONFLICT(record_id) DO UPDATE SET
      segments = excluded.segments,
      unlocked_indices = excluded.unlocked_indices,
      created_at = excluded.created_at
  `).run(id, recordId, openid, JSON.stringify(segments), Date.now());
}

function getDestinyByRecordId(recordId) {
  const row = db.prepare(`SELECT * FROM destinies WHERE record_id = ?`).get(recordId);
  if (!row) return null;
  return {
    id: row.id,
    recordId: row.record_id,
    openid: row.openid,
    segments: JSON.parse(row.segments),
    unlockedIndices: JSON.parse(row.unlocked_indices),
    createdAt: row.created_at
  };
}

function updateDestinyUnlocked(recordId, indices) {
  db.prepare(`
    UPDATE destinies SET unlocked_indices = ? WHERE record_id = ?
  `).run(JSON.stringify(indices), recordId);
}

module.exports = {
  initDb,
  insertRecord,
  getRecordsByOpenid,
  getRecordById,
  getPendingReplies,
  updateReply,
  getStats,
  insertDestiny,
  getDestinyByRecordId,
  updateDestinyUnlocked,
  DEMO_OPENID
};
