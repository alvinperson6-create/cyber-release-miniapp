// 违规样例：renderer 不得直接访问数据库。
const Database = require('better-sqlite3');

function peek() {
  const db = new Database('server/data.db');
  return db.prepare('SELECT * FROM journeys').all();
}

module.exports = { peek };
