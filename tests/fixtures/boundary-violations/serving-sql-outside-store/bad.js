// 违规样例：原始 SQL 只能出现在存储适配层。
// workflow 不得绕过 commit 直接写表。
function cheat(encounterId) {
  const db = require('better-sqlite3')('server/data.db');
  db.prepare("UPDATE encounters SET status = 'decided' WHERE id = ?").run(encounterId);
}

module.exports = { cheat };
