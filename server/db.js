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
      reply_created_at INTEGER
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
  console.log(`[db] Seeded ${demoRecords.length} demo records`);
}

function insertRecord(record) {
  const stmt = db.prepare(`
    INSERT INTO records (
      id, openid, creature, water, feeling, feedback_label, sign,
      created_at, reply_at, reply_bg, reply_emoji, reply_text, reply_created_at
    ) VALUES (
      @id, @openid, @creature, @water, @feeling, @feedback_label, @sign,
      @created_at, @reply_at, @reply_bg, @reply_emoji, @reply_text, @reply_created_at
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
    SET reply_bg = ?, reply_emoji = ?, reply_text = ?, reply_created_at = ?
    WHERE id = ?
  `).run(reply.bg, reply.emoji, reply.text, now, id);
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

module.exports = {
  initDb,
  insertRecord,
  getRecordsByOpenid,
  getRecordById,
  getPendingReplies,
  updateReply,
  getStats,
  DEMO_OPENID
};
