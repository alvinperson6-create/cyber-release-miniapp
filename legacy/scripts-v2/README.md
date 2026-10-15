# 旧版 journey-v2 验证脚本（已归档）

这些脚本属于 Agent 工程环境改造**之前**的验证方式，已被新的验证底座取代。

| 旧脚本 | 现在用什么 |
| --- | --- |
| `verify-journey-v2.js` | `node scripts/smoke-real.js`（真实冒烟）+ `npm run check`（离线回归） |
| `verify-signal-path.js` | `node tests/scenarios/cli.js awaiting_signal`（固定场景，零外部调用） |
| `verify-stage-letter.js` | `node tests/scenarios/cli.js letter`（固定场景） |
| `build-blind-eval.js` | 盲评材料生成，改动后需按新目录结构重建 |

## 为什么不直接改好继续用

它们都硬编码启动 `server/index.js`，而本轮已把装配拆成
`serving/entrypoints/start.js` + `createApp(runtime)`；
并且固定场景已经能用可控时钟 + 固定 adapter 覆盖这些路径，不需要真实凭据。

这些脚本的**方法**仍然有效，改造时应继续遵守：

- 不写任何测试专用的决策逻辑（所有分支选择来自真实 JEV / LLM）
- 用部署级配置（如 `J_TIME_SCALE`）加速，而不是改业务逻辑
- 如实记录未覆盖的分支与降级，不伪造成功
- 产物写到 `docs/`，对应关系与结论分离

## 当前状态

它们引用的旧路径（`server/index.js`、`server/public`）已不存在，直接运行会失败。
保留它们只为历史参考，**不要当作现行 API 说明**。

若要重新启用盲评材料生成，先对照 `serving/entrypoints/start.js`
把 `spawn` 的命令行与工作目录更新，再核对产物路径。
