// 违规样例：shared 层不得读环境变量或引入 IO。
const KEY = process.env.SOME_SECRET;

module.exports = { KEY };
