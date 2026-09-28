# 赛博放生 · journey-v2 进度记录

更新：2026-09-29（无人值守实施轮）
依据：`handoff.md`（2026-09-29 第一阶段）
本文如实记录本轮做了什么、卡在哪里、怎么解决、什么没做。

## 1. 起点
- 工作区存在上一轮 JEV 改造的未提交改动与材料。已按要求**先记录后动手**：
  - `docs/baseline-v2/git-status-baseline.txt`（改动清单快照）
  - `docs/baseline-v2/worktree-uncommitted.patch`（全部未提交差异）
  - `docs/baseline-v2/old-tests-result.txt`（旧 61 用例全绿的最后一次运行记录）
- 旧四集流水线代码与旧测试整体移入 `legacy/story-v0/`（含 README 说明来源与不可运行性），作为产品演变证据保留；旧文档 `docs/jev-*` 原样保留。

## 2. 已完成（对照 handoff §4 实施顺序）
1. **基线与数据边界** ✅：见上。新 schema 从空库开始；`seedDemoData()` 与 H5 本地演示种子已随旧代码移除——新空库首访不再灌旧四集示例。测试一律独立 `DB_PATH`。
2. **权威旅程内核** ✅：`server/db.js` 全新 schema（creatures/journeys/motivations/encounters/facts/mechanism_cards/messages/tasks/model_calls/sessions），乐观锁 + 条件更新 + 租约任务队列；模型调用全部在事务外；读取 API 不触模型。
3. **共享编排核心** ✅：`server/director.js`（导演契约 journey-director-v1）+ `server/orchestrator.js`（状态机）+ `server/scheduler.js`（公平租约调度）+ `server/clock.js`（可注入时钟）+ `server/boundary.js`（字面边界）+ `server/textmatch.js`（机制字面去重）。`POST /api/release` 先持久化即回 `preparing`；旧 `/api/destiny`、`/api/reply/generate`、旧旅程分支、按 `reply_at` 预生成调度全部停挂。
4. **H5 可用流程** ✅：`web-app.html` 整页重写（放生/信箱/再出发/语气/结束/信号回应），HttpOnly 会话绑定所有者，全部动态文本 esc 转义，无倒计时/广告/四集。
5. **其他入口** ✅：`/api/world/pulse` 改为只返回计数与水域（无用户原话）；小程序与 `cyber-release-miniapp.html` 未接入 v2、已从新版叙事除名（历史原型保留）。
6. **机制多样性/幽默/配图** ✅：机制卡 + 字面去重 + 边界带 JEV 窄比较 + 每遭遇至多一次定向重提案；字面拦截 + JEV 窄语义三查（虚构/贬低/账本冲突）+ 一次修订 + withheld；语气仅影响未来；非阻塞预算配图。

## 3. 测试
`tests/`（新套件，39 用例全绿）：journey-core / contact / scheduler-safety / dedup-boundary / db-v2 / situations（沿用）。辅助：`tests/helpers/world.js`（桩世界：隔离 DB + 虚拟时钟 + LLM/JEV 桩路由）。

调试中抓到并修掉的真 bug（值得留档）：
- `db.js` 的 `DB_PATH` 在模块加载期固化 → 同进程测试共享第一个库（改为 `initDb()` 时解析 + `closeDb()`）。
- `orchestrator/situations` 在加载期解构 `jevJudge` → 同进程第二个测试世界的桩不可见（改为调用时属性访问）。
- `reconcileJourneys` 会为 paused 旅程无限重建任务（`getActiveJourneys` 排除 paused）。
- `handleNoneFit` 读取 snake_case 字段导致重提案 SQL NOT NULL 失败（camelCase）。
- 用户按时补给后决策任务 500ms 才到期 → 改为立即到期。
- 真实模型提案结构偶发不合规 → 动作字段归一化（字符串/别名键/缺 id 容忍）+ 携带校验错误的定向修订。

## 4. 真实生产路径验证
`scripts/verify-journey-v2.js`（真实 HTTP + 千帆文本模型 + 真实 JEV + 真实 SQLite，子进程服务器可 SIGTERM/重启；节奏用 `J_TIME_SCALE=600` 部署配置缩放）。
结果与用量见 `docs/journey-v2-eval/{trace,summary}.json` 与 `docs/journey-v2-validation.md`（如实记录含失败轮次）。

## 5. 未做 / 未验证（如实）
- 人工盲评未做：材料已生成（`docs/journey-v2-eval/blind-eval/`），标注 `humanReviewed: false`。换皮、好笑程度、被尊重感、继续阅读意愿**均无人评结论**。
- 配图质量未评（仅核对非阻塞与落盘）；验证轮中配图额度=1。
- 跨设备同步、旅程恢复（paused 后的续跑按钮）未做——属产品决策，本阶段无承诺。
- 小程序未接入 v2。
- 第二阶段（相遇+共同世界、跨旅程故事档案）未做，未混入。


## 6. handoff §6 完成标准逐项审计（附证据）

| # | 标准 | 判定 | 证据 |
| --- | --- | --- | --- |
| 1 | H5 与后端真实主链已改动态单生物旅程；新入口无固定终局日期/四集/广告 | ✅ | `web-app.html` 重写（真实浏览器走查：放生→回执“准备出发”→信箱→收束信→再次出发按钮）；`grep` 无 feedbackTime/replyAt/ad；`server/routes/` 仅 journey/release/world |
| 2 | 生物跨出发保持身份；本程动机持续供 JEV；新烦恼不被旧档案吞掉 | ✅ | 测试 contact「同一生物再出发」；验证 B 场景（同 `CRT-*` 新 `JRN-*`，动机文本不同）；JEV 决策输入始终含动机档案（journey-core「持续动机」断言） |
| 3 | 事件 LLM 临场提出、JEV 实际选择、程序守住不可改写因果 | ✅ | 真实验证决策审计：12 遭遇 = 11×`jev` + 1×程序搁下，0 伪来源；乐观锁/一次性提交测试（db-v2、journey-core「版本冲突」「幂等」）；旧固定三节点已归档 `legacy/story-v0/` |
| 4 | 两类联系、非终局来信、无响应继续、主动/用户结束、后台自主推进可从真实 H5 流程操作和恢复 | ✅ | 真实 HTTP 验证 A/B/C/A2 全过；真实信号→补给→决策（盲评 B 份，真实模型）；SIGTERM 重启恢复；H5 浏览器走查操作同一套 API |
| 5 | 机制去重与幽默边界在生成前生效；有限检查不默认反复重写；“轻一点/更荒唐一点”只对未来 | ✅ | dedup-boundary 测试（重提案每遭遇 ≤1、坏信永不公开、语气只改未来 prompt）；真实轮 8 次 dedup_reproposal 全部合规 |
| 6 | 旧四集/广告/旧数据兼容负担从生产路径移除；未改造客户端不再宣称旧路径 | ✅ | 旧 API/调度停挂，代码+旧测试冻结于 `legacy/story-v0/`（61 旧测试随之退役）；小程序与 miniapp 原型在文档中明确除名（`journey-v2-design.md` §7） |
| 7 | 离线/真实连通/内容效果三层证据分开报告；人工未评、图片未评、预算与故障边界如实说明 | ✅ | `journey-v2-validation.md` §0-§4（人工未评、图片未评、真实 JEV 未选无补给到期分支均如实列出） |
| 8 | 相遇/共同世界与跨旅程故事档案未混入 | ✅ | 无跨旅程用户可见档案（仅内部机制卡摘要 ≤3 张供去重）；无相遇代码；design §8 明确留待第二阶段 |

**结论：§6 全部 8 项达成；其中“内容效果”的机器层已验证、人工层如实标注未评。**
