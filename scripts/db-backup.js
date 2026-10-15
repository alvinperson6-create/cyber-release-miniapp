#!/usr/bin/env node
// 赛博放生 · 一致性数据库备份 / 恢复
//
// 为什么不能直接 cp：SQLite 运行在 WAL 模式，只复制主文件会丢掉 -wal 里尚未
// checkpoint 的事务，得到的是不一致快照。统一走 SQLite 官方 backup API。
//
// 用法：
//   node scripts/db-backup.js backup [目标路径]
//   node scripts/db-backup.js restore <备份文件>
//   node scripts/db-backup.js verify <备份文件>
//
// 备份默认写到 .workbuddy/backups/（已被 git 忽略），不提交运行数据。

const path = require('node:path');
const fs = require('node:fs');

// 依赖已上移到仓库根（node_modules/ 在根目录），不要写死旧路径
const Database = require('better-sqlite3');

const ROOT = path.join(__dirname, '..');

function resolveDbPath() {
  return process.env.DB_PATH ? path.resolve(process.env.DB_PATH) : path.join(ROOT, 'data', 'data.db');
}

async function backup(destArg) {
  const src = resolveDbPath();
  if (!fs.existsSync(src)) throw new Error(`源数据库不存在：${src}`);
  const dest = destArg
    ? path.resolve(destArg)
    : path.join(ROOT, '.workbuddy', 'backups', `data.db.${Date.now()}`);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const db = new Database(src, { readonly: true });
  try {
    await db.backup(dest);
  } finally {
    db.close();
  }
  console.log(`backup ok → ${dest}`);
  return dest;
}

function verify(file) {
  const db = new Database(file, { readonly: true });
  try {
    const integrity = db.pragma('integrity_check', { simple: true });
    const tables = db.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`
    ).all().map(r => r.name);
    const counts = {};
    for (const t of tables) {
      if (t.startsWith('sqlite_')) continue;
      try { counts[t] = db.prepare(`SELECT COUNT(*) AS c FROM "${t}"`).get().c; } catch (e) { counts[t] = null; }
    }
    const out = { integrity, tables, counts };
    console.log(JSON.stringify(out, null, 2));
    if (integrity !== 'ok') throw new Error(`integrity_check=${integrity}`);
    return out;
  } finally {
    db.close();
  }
}

async function restore(file) {
  const dest = resolveDbPath();
  if (!fs.existsSync(file)) throw new Error(`备份不存在：${file}`);
  // 先给当前库留一份，避免恢复动作本身不可逆
  if (fs.existsSync(dest)) {
    const safety = path.join(ROOT, '.workbuddy', 'backups', `data.db.before-restore.${Date.now()}`);
    fs.mkdirSync(path.dirname(safety), { recursive: true });
    const db = new Database(dest, { readonly: true });
    try { await db.backup(safety); } finally { db.close(); }
    console.log(`restore 前自动备份 → ${safety}`);
  }
  const src = new Database(file, { readonly: true });
  try {
    await src.backup(dest);
  } finally {
    src.close();
  }
  console.log(`restore ok → ${dest}`);
}

(async () => {
  const [cmd, arg] = process.argv.slice(2);
  try {
    if (cmd === 'backup') await backup(arg);
    else if (cmd === 'verify') verify(path.resolve(arg));
    else if (cmd === 'restore') await restore(path.resolve(arg));
    else {
      console.log('用法：node scripts/db-backup.js <backup|restore|verify> [路径]');
      process.exitCode = 2;
    }
  } catch (err) {
    console.error('db-backup failed:', err.message);
    process.exitCode = 1;
  }
})();
