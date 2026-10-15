// 违规样例：renderer 不得 import serving（只能通过 HTTP edge 调 API）。
const { createRuntime } = require('../../../serving/entrypoints/runtime');

module.exports = { createRuntime };
