// 违规样例：shared 层不得 import serving。
// 这个文件**故意违规**，只用于 boundary-check --self-test 证明规则会失败。
// 绝不允许出现在 shared/ 或任何生产路径中。
const store = require('../../../serving/adapters/store');

module.exports = { store };
