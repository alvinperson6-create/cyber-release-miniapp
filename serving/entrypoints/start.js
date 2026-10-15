#!/usr/bin/env node
// 赛博放生 · 生产启动入口
//
// 只有这个文件负责"实际启动"：读配置 → 装配 runtime → 初始化 DB →
// 启动调度 → 监听端口。导入 app.js / runtime.js 都不会启动任何东西。
//
// 用法：node --env-file=server/.env serving/entrypoints/start.js

const { createRuntime } = require('./runtime');
const { createApp } = require('./app');

const PORT = parseInt(process.env.PORT || '3001', 10);

async function main() {
  const runtime = createRuntime({ mode: 'production' });

  const [textModel, jev] = [runtime.textModel, runtime.jev];
  console.log(`[ai] 文本模型：${textModel.isEnabled() ? '已启用' : '未启用（旅程将无法开局，设置 AI_API_KEY 启用）'}`);
  console.log(`[jev] JEV 判断：${jev.isEnabled() ? '已启用' : '未启用（决策会重试/暂停，绝不用规则冒充）'}`);
  console.log(`[db] 数据位置：${runtime.meta.dbPath}`);

  const app = createApp(runtime);

  // 后台调度：页面关闭也推进
  runtime.startScheduler();

  const server = app.listen(PORT, () => {
    console.log(`赛博放生 API (journey-v3) running at http://localhost:${PORT}`);
  });

  // 优雅关闭：释放 timer 与数据库，不留残余资源
  const shutdown = async (signal) => {
    console.log(`\n[server] ${signal} received, shutting down...`);
    server.closeAllConnections?.();
    await new Promise(r => server.close(r));
    await runtime.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch(err => {
  console.error('[server] failed to start:', err);
  process.exit(1);
});
