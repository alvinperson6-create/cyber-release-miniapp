# 赛博放生 · Agent 工程环境改造 · 设计报告

日期：2026-10-15
执行依据：`docs/HANDOFF-Agent工程环境改造.md`
执行 commit：见 `docs/agent-environment-progress.md` 的执行记录

本文件说明**最终落地了什么结构、边界怎么强制、契约与版本语义、数据怎么迁**。
交接文档里的目录树是候选结构，验收约束是职责、通信、提交与自动检查——本轮按后者执行。

---

## 1. 最终结构

```text
shared/contracts/            公开契约（纯模块，浏览器与服务共用）
  errors.js                 错误码 → HTTP 状态码的唯一来源
  enums.js                  状态/阶段/消息类型/模型操作名/提交结果/调度结果
  commands.js               命令输入校验 + 幂等指纹
  vocabulary.js             生物、水域、语气等共享词表
  dto.js                    对外 DTO 序列化 + 响应校验
  index.js                  统一入口

renderer/                   前端（只能通过 HTTP edge 调 API）
  index.html                H5 入口（含客户端状态管理）
  assets/                   vendor / globe3d.js / globe-config.json / world-land.json / images

serving/
  entrypoints/
    runtime.js              依赖装配工厂（导入无副作用）
    app.js                  createApp(runtime)：路由、静态、错误处理
    start.js                唯一实际启动入口
    api-router.js           业务 HTTP 通信入口（薄壳，无业务逻辑）
    session.js              匿名会话与归属
  adapters/
    store.js                SQLite：迁移、写路径、事务
    clock.js                可控时钟
    guards.js               服务护栏与开关（纯策略）
    text-model.js           文本模型调用 + 统一记账/预算
    jev.js                  JEV 判断适配器
    image.js                配图适配器
  features/journey/
    commands/               release / reply / end（含幂等）
    queries/                views.js（只读）
    workflows/              orchestrator.js（编排）
    context/                director.js（提示词）/ builder.js（context）/ situation-recognition.js
    policies/               text-boundary.js / mechanism-similarity.js
    commits/                settlement.js（原子提交 + 提交前复核）
  scheduler.js              调度：done / defer / retry / failed + 租约条件

tests/
  helpers/world.js          实例级依赖注入的唯一 fixture 来源
  *.test.js                 存储/旅程/竞态/装配/HTTP/前端契约
  scenarios/                固定场景 + CLI 入口 + 批量验证
  fixtures/boundary-violations/  边界检查器的违规样例（自测用）

tooling/
  check.js                  统一检查入口
  boundary-check.js         依赖边界检查器（含 --self-test）
  contracts-check.js        契约纯度与映射检查
  frontend-check.js         前端静态与资源检查
  run-tests.js              测试运行器

scripts/
  db-backup.js              一致性备份/恢复（WAL 安全）
  sync-globe-config.js      地球配置同步（源缺失时明确报错）
  smoke-real.js             真实生产路径冒烟（隔离库、真实凭据）

docs/                       设计与验证材料
legacy/                     历史原型（禁止被生产路径引用）
tooling/templates/          功能模板与效率记录模板
```

### 与交接候选结构的有意偏差

| 交接建议 | 本轮落地 | 原因 |
| --- | --- | --- |
| `renderer/features/{release,mailbox,timeline}` 拆多个文件 | 单文件 `renderer/index.html` | 现有 H5 是单文件交付物；拆成多文件需要引入构建步骤，超出本轮范围。**边界规则仍然强制**（renderer 不得 import serving / 不得碰 DB），并新增 `state.serverViews`/`state.drafts`/`state.ui` 三段式状态分离。 |
| `serving/adapters` 下再分 provider 目录 | 单文件适配器 | 当前只有一个 SQLite、一个文本模型 provider 集合；按 provider 拆目录属于过度设计。 |
| TypeScript 渐进迁移 | 暂未引入 | 契约层已有运行时校验 + 边界检查器强制，类型检查的边际收益在当前规模下不显著。**已在交接要求中记为可选而非验收项**，不谎称已实现。 |

---

## 2. 依赖边界（由 tooling/boundary-check.js 强制）

规则不是文档约定，而是会失败的检查：

| 规则 | 含义 | 检查方式 |
| --- | --- | --- |
| `shared-no-serving` | shared 不得 import renderer/serving | 依赖图 |
| `shared-no-io` | shared 不得含 IO / env / 密钥 / 副作用 | 正则（process.env、fs/path/child_process/http、better-sqlite3、fetch） |
| `renderer-no-serving` | renderer 只能通过 HTTP edge 调 API | 依赖图 |
| `renderer-no-db` | renderer 不得直接访问数据库 | 正则 |
| `serving-no-legacy` | 生产路径不得依赖 legacy 或测试场景 | 依赖图 |
| `sql-only-in-store` | 原始 SQL 只允许在 `serving/adapters/store.js` | 正则 |
| `no-legacy-in-shared-renderer` | shared/renderer 不得引用 legacy | 依赖图 |

**自测证明规则会失败**：`node tooling/boundary-check.js --self-test`
扫描 `tests/fixtures/boundary-violations/` 下 6 个故意违规的样例，
要求每一个都被拒绝。当前输出：

```text
✔ renderer-imports-serving     → serving-no-legacy
✔ renderer-touches-db          → renderer-no-db
✔ serving-imports-legacy       → serving-no-legacy
✔ serving-sql-outside-store    → sql-only-in-store
✔ shared-imports-serving       → serving-no-legacy
✔ shared-reads-env             → shared-no-io
全部违规样例均被拒绝。
```

> 注：`serving-no-legacy` 与 `shared-no-serving` 是同一条依赖图规则在不同层的表现，
> 自测按层归类，因此同名。这是规则的合并，不是缺失。

---

## 3. 契约与版本语义

### 3.1 契约版本

`shared/contracts/dto.js` 导出 `CONTRACT_VERSION = 'journey-contract-v2'`，
`GET /api/health` 暴露该值。破坏性变更时 +1，客户端可据此拒绝不兼容响应。

### 3.2 错误码 → HTTP 状态码

唯一来源是 `shared/contracts/errors.js`。语义：

- **4xx**：请求本身不合法或与当前状态冲突，重试无意义。
- **409**：与当前状态冲突（换时间或改目标才可能成功）。
- **503**：服务侧问题，换时间重试可能成功。
- **归属类一律 404**（`journey_not_found` / `creature_not_found` / `signal_not_found` /
  `encounter_not_found`），不泄露"存在但不是你"。

`tooling/contracts-check.js` 逐个断言所有错误码都有确定的 4xx/5xx 状态码与对外消息。

### 3.3 截止等号语义

`now <= signalDueAt` 视为**按时**（等号含在内）；`now > signalDueAt` 为迟到。
调度侧 `now < signalDueAt` 时才 defer，避免同一时刻既判超时又判等待。

### 3.4 版本锁的适用范围

`state_version` 只服务**事实/决策并发**（结算提交、遭遇决策）。
它**不覆盖**每次消息、语气或图片变化，因此**不能**当作前端 `snapshotVersion`。
前端改用请求序号 + 代次 + 命令后失效机制（见 §6）。
这一条按交接要求显式记录，避免下一位 Agent 误用。

### 3.5 幂等语义

- 幂等键格式：`^[A-Za-z0-9_.:-]{8,128}$`，不传则不启用幂等（保持旧调用方可用）。
- 分域：`(owner_key, operation, request_id)` 唯一约束。
  同键同载荷返回既有结果（`replayed: true`）；同键异载荷返回 `idempotency_conflict`（409）。
- 去重结果与业务变化在**同一事务**写入，重启后仍有效。
- HTTP 层：优先读 `Idempotency-Key` 头，其次 body 的 `requestId`。

---

## 4. 数据迁移

### 4.1 路径锚定

```
DB_PATH  →  CYBER_RELEASE_DB  →  server/data.db（历史位置）
```

搬迁文件前先把默认路径锚定到**既有位置**，代码再也不会带着数据"搬家"。
`LEGACY_DB_PATH` 由 `__dirname` 之外计算（`<repo>/server/data.db`），
因此 `serving/adapters/store.js` 放到哪都不影响数据位置。

### 4.2 版本化可重入迁移

`PRAGMA user_version`，当前 `SCHEMA_VERSION = 2`：

| 版本 | 名称 | 内容 |
| --- | --- | --- |
| 1 | `journey_v2_core` | journeys-v2 全部表与索引（`CREATE TABLE IF NOT EXISTS`） |
| 2 | `command_idempotency_and_operations` | `command_requests`、`operations`、`task_dedup`；`model_calls` 增加审计列 |

约定：

- **只增不改**：不删既有列、不重写历史数据、不回填过去不存在的输入或决定。
- **可重入**：每步先探测是否已应用；重复执行 `applied` 为空数组。
- **加唯一约束前核对历史重复**：`preflightUniqueIndex()` 有重复就明确失败，
  绝不通过删历史记录让迁移"通过"。
- 迁移演练在副本上执行（见 §4.3）。

### 4.3 备份与恢复

```bash
node scripts/db-backup.js backup                    # → .workbuddy/backups/
node scripts/db-backup.js verify .workbuddy/backups/data.db.pre-refactor
node scripts/db-backup.js restore <备份文件>         # 恢复前自动再备份一次
```

走 SQLite 官方 `backup()` API，**不直接 `cp`**：WAL 模式下只复制主文件会丢掉
`-wal` 里尚未 checkpoint 的事务。`verify` 会输出 `integrity_check` 与逐表行数。

本轮实际执行的备份（改造前）：

```text
backup ok → .workbuddy/backups/data.db.pre-refactor
integrity: ok
tables: destinies, records
counts: destinies=54, records=54
```

> **重要事实**：改造前仓库里**没有 journey-v2 运行时数据**。
> `server/data.db` 只含旧四集原型表（`destinies`/`records`），
> `docs/jev-eval/*.db` 也只有旧表。journey-v2 的 journeys/encounters/messages
> 全部在临时库里。因此"保留现有 journey-v2 数据"在本轮的实际含义是：
> **不破坏既有文件，且迁移后在旧库上验证过可读**（见 §4.4）。
> 如果用户本地另有未提交的 journey-v2 运行库，用 `DB_PATH` 指向它即可，
> 迁移会原地增量应用。

### 4.4 迁移后读取验证

`tests/store.test.js` 的两个用例：

- 旧库（含 `records` 表 1 行）加新表后，旧行数不变、`journeys` 表已创建。
- 重复执行迁移 `applied` 为空，`user_version` 停在 2，表数量不变。

---

## 5. 提交护栏与竞态

### 5.1 提交结果语义

`shared/contracts/enums.js` 的 `COMMIT_RESULT`：
`applied` / `already_applied` / `stale` / `cancelled` / `conflict`。
`orchestrator.logCommit()` 对非 `applied` 的结果打日志，不把所有结果记成"完成"。

### 5.2 模型 await 后的复核

所有 `commits/*` 在提交前重新核对：

1. **旅程状态**：`readJourneyForCommit()` 取当前状态；
   `ended_user`/`ended_natural`/`aborted` → `cancelled`，其他非预期状态 → `stale`。
2. **决策输入快照**：`decideEncounter({ expectSupply, expectStateVersion })`。
   生成决策时的补给位若已变化 → `stale`，重新排一次决策，
   **新增按时补给不会被旧的无补给决策悄悄吞掉**。
3. **租约持有者**：`completeTask` / `rescheduleTask` / `failTask` 都带 `leaseKey` 条件。
   旧持有者影响 0 行，不会覆盖新持有者，也不会把 `cancelled` 改回来。
4. **已提交检查**：业务 operation 用 `operations` 表的 `INSERT OR IGNORE` 唯一约束
   做原子去重，不用"先查再插"的非原子方式。

### 5.3 原子性与重启恢复

`commitResolution` 在**同一事务**内写入：encounter resolved + facts + 机制卡 +
旅程版本推进 + 下一步任务（`schedule` 回调）。
不会出现"落账成功但永久丢下一步"。

`reconcileJourneys` 用 `task_dedup(journey_id, kind, goal_key)` 按业务目标去重补任务，
崩溃恢复不制造重复任务。历史记录缺少排程意图时，走 `contact` 检查点补一次
（保住收束机会），而不是直接提案。

### 5.4 defer 与 retry 分离

`serving/scheduler.js`：

| 结果 | 触发 | 重试次数 | 排程 |
| --- | --- | --- | --- |
| `done` | 任务完成 | — | — |
| `defer` | 正常等待（信号未到期等） | **不消耗** | 按业务给出的 `dueAt` |
| `retry` | 真实错误 | 计入 | 受限退避 `guards.backoffMs` |
| `failed` | 永久失败 / 超限 | — | 旅程如实暂停 |

`orchestrator.taskDecide` 在 `signal_sent && !supplyMessageId && now < signalDueAt`
时返回 `{status: DEFER, dueAt: signalDueAt}`，不再伪装成失败重试。

### 5.5 统一模型调用入口

- 所有真实网络尝试都经过 `text-model.invoke()` / `jev.judge()`，两者共用
  同一个 `onCall` 记账回调。
- `runtime.js` 的 `withLedger()` 会给**注入的自定义 adapter 也包一层**，
  避免测试/场景路径绕过台账。
- 处境识别（`situation_recognition`）同样进台账——旧实现曾绕过。
- 区分逻辑 operation 与 transport attempt（`attempt` 列）。
- 无网络调用的预算拒绝用 `status='budget_denied'` 单独记录，不混入真实尝试。
- 模型 adapter 只返回结果，**不拥有故事事实提交权**。

### 5.6 迟到回复的后续参考链

`context/builder.js` 的 `classifySupplies()` 把本程留言分成：

- `ontimeSupplies`：占用它所回复的那件遭遇的补给位。
- `lateSupplies`：进入 `buildDecisionState()` 的「本程迟到参考」字段，
  明确标注"来晚了：没有改写任何已发生的选择"。

范围限于本程，不跨程；不影响已提交动作。修复了交接 §2.1 指出的参考链缺口。

---

## 6. 前端状态分离

`renderer/index.html` 的三段式：

```js
state.serverViews = {}   // journeyId → JourneyView（服务端权威副本）
state.drafts      = {}   // signalMessageId → {text, at}（按信号，不按旅程）
state.ui          = {}   // timelineOpen / timelineLoaded（轮询不覆盖）
```

竞态闸门：

- `state.viewGeneration`：切换旅程时 +1，旧代次的响应一律丢弃。
- `state.reqSeq` + `isFresh(req, lastAppliedSeq)`：序号落后的响应算晚回，不回退视图。
- `state.pendingCommands`：命令在途时旧轮询不回写；命令完成后强制重读。
- `validateView(v)`：非法响应如实报错，**不写入缓存**。
- `AbortController` 只是省流量，真正的防线是序号与代次校验。

回复必须带 `signalMessageId` + `encounterId`；信号切换后旧草稿不会误投
（草稿按信号 ID 存取，信号变了就取不到旧草稿）。

---

## 7. 取舍与未做

| 事项 | 决定 | 理由 |
| --- | --- | --- |
| 类型检查（TypeScript） | 未引入 | 契约层已有运行时校验 + 边界检查；交接将其列为"可渐进迁移"而非验收项。 |
| 微服务 / 事件总线 | 不做 | 保留单 Node 进程 + SQLite；HTTP 继续承担跨边界通信。 |
| `snapshotVersion` | 未增加 | 需先定义"全部可见变化如何推进"，交接明确要求先验证再加。本轮用请求序号 + 失效机制达成同等效果。 |
| 恢复暂停旅程按钮 | 未加 | 交接明确"本轮不新增恢复按钮或改变暂停策略"。 |
| 图片 URL 兼容 | 保留 | 既有消息的 `/images/<file>` 仍可达（资源已迁到 `renderer/assets/images`，路由前缀不变）。 |

---

## 8. 相关文档

- `docs/agent-environment-runbook.md`：可执行命令与故障定位
- `docs/agent-environment-validation.md`：本轮实际跑出来的结果与未验证项
- `docs/agent-environment-progress.md`：阶段完成项与遗留事项
- `AGENTS.md`：下一位 Agent 的入口规则
- `docs/FEATURE-MAP.md`：功能地图（怎么到达、怎么验证）
