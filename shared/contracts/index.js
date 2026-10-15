// 赛博放生 · 共享契约统一入口
//
// 边界规则（阶段 3.1）：本目录只含公开类型、枚举、纯 schema/校验与共享纯数据。
// 不得 import renderer/serving，不得含 IO、env 读取、密钥与初始化副作用。
// 内部数据库行、ownerKey、提示词与模型响应不进入此层。

const errors = require('./errors');
const enums = require('./enums');
const commands = require('./commands');
const vocabulary = require('./vocabulary');
const dto = require('./dto');

module.exports = {
  ...errors,
  ...enums,
  ...commands,
  ...vocabulary,
  ...dto
};
