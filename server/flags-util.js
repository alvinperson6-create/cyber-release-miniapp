// 布尔环境变量解析（flags/其它模块共用的小工具，独立成文件避免循环依赖）
function parseBoolEnv(name, defaultValue) {
  const raw = process.env[name];
  if (raw == null || raw === '') return defaultValue;
  return raw !== '0' && raw.toLowerCase() !== 'false' && raw.toLowerCase() !== 'off';
}

module.exports = { parseBoolEnv };
