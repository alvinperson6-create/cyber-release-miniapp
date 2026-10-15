# 赛博放生 · 功能地图

这张表回答两个问题：**某个功能怎么到达**、**改了怎么验证**。

- locator 优先用可访问名称（中文文案）与稳定 `id`；动态卡片用业务 ID。
- 每行都给出「Host 预期变化」与「在哪里验证」。
- 迁移旧 ID 时必须同步更新本表与 `tests/frontend-contract.test.js`，不要留过期导航。

---

## 1. 用户可见功能

| 功能 | 怎么到达 | 稳定 locator | 对应命令 / 查询 | Host 预期变化 | 验证位置 |
| --- | --- | --- | --- | --- | --- |
| 放生建程 | 首页「放生」按钮 | `#releaseBtn`、文本「放生」 | `POST /api/release` | 新增 `creatures` + `journeys` 行；`status='preparing'`；插入 `opening` 任务 | `journey-core.test.js` 第 1 项；场景 `preparing` |
| 选择生物 | 首页生物卡片 | 文本「锦鲤」「乌龟」「云朵」 | 无（纯前端状态） | — | `frontend-contract.test.js` 默认值用例 |
| 选择水域 | 2D 地图标记 / 3D 地球 | `.water-marker[data-water=xihu]` | 无 | — | 手动 |
| 写烦恼 | 首页文本框 | `#feelingText` | 随放生一起提交 | 原话进 `journeys.feeling` 与 `motivations.raw_text` | `journey-core.test.js` |
| 选择语气 | 首页语气卡片 | 文本「刚好」「轻一点」「更荒唐一点」 | 随放生一起提交 | `journeys.tone` | 同上 |
| 再次出发 | 结束后的「让…再次出发」 | `#reGoBtn` | `POST /api/release`（带 `creatureId`） | 复用同一 `creature_id`，新建 `journey_id` | `journey-core.test.js` 最后一项 |
| 打开信箱 | 底部导航「信箱」 | 文本「信箱」 | `GET /api/journeys`、`GET /api/journey/:id` | 只读，不推进 | `http-contract.test.js` 读取用例 |
| 切换旅程 | 信箱顶部旅程卡片 | `.jchip[data-jid=...]` | `GET /api/journey/:id` | 只读；切换触发前端代次 +1 | `frontend-contract.test.js` 晚回闸门用例 |
| 读来信 | 信箱消息卡片 | `.msg-card`（按 `data-mid`） | `GET /api/journey/:id` | 只读 | `journey-core.test.js` |
| 回应信号 | 信号卡输入框 | `#signalReplyText`、`#signalReplyBtn` | `POST /api/journey/:id/reply`（**必须带** `signalMessageId`） | `encounters.supply_message_id` 落库；插入 `decide` 任务 | `race-and-guards.test.js` 第 4–5 项；场景 `awaiting_signal` |
| 展开回顾 | 结束后的「展开完整旅程时间线」 | `#timelineBtn`、`#timelineBox` | `GET /api/journey/:id/timeline` | 只读；仅终态开放（否则 403） | `http-contract.test.js` 错误码用例 |
| 改语气（旅程内） | 信箱底部语气切换 | `.tone-mini[data-tone=absurd]` | `POST /api/journey/:id/tone` | `journeys.tone` 更新；不改已提交事实 | `journey-core.test.js` 语气用例 |
| 结束旅程 | 信箱底部「结束这段旅程」 | `#endJourneyBtn` | `POST /api/journey/:id/end` | `status='ended_user'`；取消任务；写一条 `system` 消息 | `race-and-guards.test.js` 结束幂等用例 |
| 世界脉搏 | 首页底部 | `#worldPulseLine` | `GET /api/world/pulse` | 只读；**不含任何用户原话** | `race-and-guards.test.js` 所有权用例 |

---

## 2. 后台任务（无 UI，按任务类型）

| 任务 kind | 触发 | 模型操作 | 落库 | 验证位置 |
| --- | --- | --- | --- | --- |
| `opening` | 放生后 | `situation_recognition` + `opening` | `motivations` + 首个 `encounters` + `status='active'` | 场景 `preparing` → `settled` |
| `decide` | 提案冻结 / 补给到达 / 信号到期 | `action_decision` | `encounters.status='decided'`（或寄信号） | `journey-core.test.js` 决策项 |
| `signal_expiry` | 信号寄出后按 `dueAt` | 无 | 标记信号 `expired`，唤醒 `decide` | 场景 `awaiting_signal` |
| `settle` | 决策落账后 | `settlement`(+可选 repair) + `settlement_check` | `encounters.status='resolved'` + `facts` + `mechanism_cards` | `journey-core.test.js` 结算项 |
| `propose` | 联系检查点后 | `proposal`(+可选 `reproposal`/`dedup_check`) | 新 `encounters` 行 | 场景 `settled` |
| `letter` / `final_letter` | 联系检查点判定 | `letter_write` / `final_letter_write` + `letter_check` | `messages`；`final_letter` 同时置 `ended_natural` | 场景 `letter` / `ended_natural` |
| `image` | 阶段来信/收束信后 | `image` | 附加 `messages.image` | **本轮真实配图未验证**（见 validation §6） |
| `contact` | 最大静默护栏 | `contact_checkpoint` | 排下一步任务 | `orchestrator.js` 的 `maybeGuardSilence` |

---

## 3. 环境与验证入口

| 目的 | 命令 | 产物 |
| --- | --- | --- |
| 完整检查 | `npm run check` | 控制台摘要 |
| 快检查 | `npm run check:fast` | 控制台摘要 |
| 场景摘要 | `node tests/scenarios/cli.js <场景>` | JSON（含 `journeyId`、隔离库路径、`externalCalls: 0`） |
| 批量场景验证 | `node tests/scenarios/verify-all.js` | 逐场景状态 |
| 真实冒烟 | `node scripts/smoke-real.js` | `docs/agent-environment-validation-artifacts/smoke-real.json` |
| 边界自测 | `node tooling/boundary-check.js --self-test` | 违规样例拒绝情况 |
| 数据库备份 | `npm run db:backup` | `.workbuddy/backups/` |

---

## 4. 关键不变量（改动时别破坏）

| 不变量 | 由谁保证 | 验证 |
| --- | --- | --- |
| 放生立即返回 `preparing`，模型调用在后台 | `commands/release.js` | `journey-core.test.js` 第 1 项 |
| 读取接口绝不调模型、不推进状态 | `queries/views.js` 只调读取函数 | `http-contract.test.js` 读取用例 |
| 所有者由服务端会话决定 | `entrypoints/session.js` + 所有路由用 `req.ownerKey` | `race-and-guards.test.js` 所有权用例 |
| 跨 owner 读一律 404 | 契约错误码表 | 同上 |
| 已提交的事不被重试或晚到结果改写 | `commits/` 的条件更新 | `race-and-guards.test.js` 结束竞态用例 |
| JEV 不可用不冒充决策 | `workflows/orchestrator.js` 抛 `jev_unavailable` | `journey-core.test.js` JEV 不可用项 |
| 回复必须带目标 | `shared/contracts/commands.js` | `race-and-guards.test.js` 第 4 项 |
| 同幂等键只落一次业务结果 | `command_requests` 唯一约束 + 同事务写入 | `race-and-guards.test.js` 前 3 项 |
| 正常等待不消耗错误重试 | `scheduler.js` 的 `defer` 分支 | `race-and-guards.test.js` defer 项 |
| 私有路径不被静态服务公开 | `entrypoints/app.js` 白名单 | `race-and-guards.test.js` 静态安全项 |
| 未来投递时间的消息不可见 | `queries/views.js` + DTO `visible` | `journey-core.test.js` |
| 语气只影响未来 | `commands/end.js` 的 `setTone` | `journey-core.test.js` 语气项 |
