# legacy/story-v0 —— 上一轮（2026-09-27 JEV 改造）的历史代码

这里是**旧产品形态**（四集命运轨迹 + 固定延时回信 + 广告解锁 + 旧三节点旅程实验）
的冻结代码快照，只作为产品演变证据保留（handoff §2/§4.1），不参与任何生产路径，
require 相对路径以原位置为准、可能无法直接运行。

现行生产代码在 `server/`（journey-orchestrator-v2：LLM 导演 + JEV 决策 + 程序权威账本）。

| 文件 | 原位置 | 说明 |
| --- | --- | --- |
| story-pipeline.js | server/ | 四集故事统一编排（处境→契约→生成→验收→修复/降级） |
| contract.js | server/ | 四集创作契约编译 |
| acceptance.js | server/ | 四集因果结构/语义验收 |
| journey.js | server/ | 旧三节点事件旅程实验（JOURNEY_ENABLED，规则回退） |
| reply-generator.js | server/ | 单封回信预生成（按 reply_at） |
| run-test-cases.js / run-one-image-test.js | server/ | 上一轮调试脚本 |
| tests/ | tests/ | 上一轮 61 个旧机制回归测试（快照；对应结果见 docs/baseline-v2/old-tests-result.txt） |
| scripts/ | scripts/ | 上一轮对照评估 / 旧真实路径验证脚本 |
| routes/ | server/routes/ | 旧 HTTP 入口：destiny（广告解锁）/ records（旧档案）/ reply（回信轮询与 /generate）——v2 已停挂 |

相关历史文档：`docs/jev-design.md`、`docs/jev-validation.md`、`docs/jev-runbook.md`、
`docs/product-history/2026-09-27-jev-handoff.md`、`docs/baseline-v2/`。
