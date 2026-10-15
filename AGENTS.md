# 赛博放生 · 仓库 Agent 规则
#
# 面向"下一个接手这个仓库的 Agent"。先读这份，再读 docs/agent-environment-design.md。
#
# 唯一现行入口：npm run check。任何改动都必须让它保持绿色。

## 0. 先跑什么

> **Node 版本**：`better-sqlite3` 是原生模块，编译时的 Node 版本必须与运行时的
> 一致。npm scripts 都经 `scripts/with-node.sh` 启动，会自动挑选可用的 Node，
> 所以 `npm start` / `npm run check` 在任何 Node 环境下都能直接用。
> 手动执行时用 `scripts/with-node.sh <命令>`。

```bash
npm run check          # 全部检查（依赖边界 → 契约 → 业务 → 场景 → 前端）
npm run check:fast     # 只跑边界 + 契约（改代码过程中用，快）
```

`npm run check` 默认不需要模型密钥、生产数据或付费服务。

## 1. 目录与边界

```
shared/contracts/     公开契约：枚举、错误码、命令校验、DTO。纯模块
renderer/             前端 H5（index.html + assets/）。只能通过 HTTP 调 API
serving/
  entrypoints/        装配与启动：runtime / app / start / api-router / session
  adapters/           存储、时钟、模型、JEV、配图
  features/journey/
    commands/         用户写操作（含幂等）
    queries/          只读视图（不调模型、不写状态）
    workflows/        编排：读 → 调模型 → 校验 → 提交
    context/          提示词构造、context builder、处境识别
    policies/         纯策略：文本边界、机制相似度
    commits/          原子提交与提交前复核
tests/                单元/契约/场景（helpers 是唯一 fixture 来源）
tooling/              check / boundary-check / frontend-check / contracts-check
docs/                 设计与验证材料
legacy/               历史原型，禁止被生产路径引用
```

硬约束（由 `npm run boundaries` 强制，违规会失败）：

- `renderer` 不得 import `serving`，不得碰数据库。
- `shared` 不得 import `renderer`/`serving`，不得有 IO、env 读取、密钥、副作用。
- 原始 SQL 只允许出现在 `serving/adapters/store.js`。
- `serving` 不得依赖 `legacy` 或 `tests`。
- `queries` 不得写业务状态或调模型。
- `workflow` 不得绕过 `commits` 直接写表。

## 2. 改动时必须知道的规则

### 2.1 模型调用
- 只有 `serving/adapters/text-model.js` 与 `jev.js` 能发起真实网络请求。
- 所有外部调用必须带**显式操作名**（`shared/contracts/enums.js` 的 `MODEL_OP`）。
  未知名会直接抛错，fixture 不会回退真实网络。
- 记账与预算在适配器层统一完成；注入的自定义 adapter 会被 runtime 包一层，
  绕过记账的写法会被检查发现（见 `runtime.js` 的 `withLedger`）。

### 2.2 提交与竞态
- 所有有副作用的落账走 `commits/`，**模型 await 之后、提交之前**必须复核：
  旅程状态、决策输入快照、租约持有者。
- 提交结果区分 `applied / already_applied / stale / cancelled / conflict`，
  不要把所有结果都记成"完成"。
- 租约收尾（`completeTask` / `rescheduleTask` / `failTask`）必须带 `leaseKey`，
  否则旧 worker 的迟到结果会覆盖新持有者。
- 正常等待返回 `defer`（按 `dueAt` 重排，不消耗错误重试次数）；
  只有真实错误才 `retry`。

### 2.3 命令与幂等
- 写命令必须带 `requestId`（前端用 `Idempotency-Key` 头）。
- 幂等结果与业务变化在**同一事务**内写入。
- 同键同载荷返回稳定结果；同键异载荷返回 `idempotency_conflict`（409）。

### 2.4 回复信号
- 回复**必须**带 `signalMessageId` 或 `encounterId`。缺少目标一律拒绝，
  **不要**加"回退到最新信号"的兼容逻辑——那会让旧信号绑定到新信号。
- 迟到回复只作为本程后续未决参考：不占补给位、不改写已提交决定。

### 2.5 数据
- 数据库路径：`DB_PATH` → `CYBER_RELEASE_DB` → `data/data.db`（历史位置，不随代码搬迁）。
- 迁移只增不改、可重入，用 `PRAGMA user_version`；改 schema 就加新版本号。
- 加唯一约束前先核对历史重复，不通过删历史记录让迁移"通过"。
- 备份/恢复用 `node scripts/db-backup.js`（走 SQLite backup API，不要直接 cp，WAL 会丢数据）。

### 2.6 前端
- 服务端副本按 `journeyId` 放 `state.serverViews`；草稿按 `signalMessageId` 放 `state.drafts`；
  临时 UI 状态放 `state.ui`。
- 每个响应都要过 `validateView()` 和 `isFresh()` 闸门（旅程 ID + 代次 + 序号）。
- 命令在途时（`state.pendingCommands > 0`）旧轮询不回写。
- 模型文本一律经 `esc()`。

## 3. 验证方法

```bash
node tests/scenarios/cli.js                  # 列出固定场景
node tests/scenarios/cli.js awaiting_signal  # 进入场景并打印摘要
npm test                                     # 只跑测试
npm run boundaries -- --self-test            # 证明边界规则确实会失败
```

场景覆盖：preparing / awaiting_signal / settled / letter / ended_natural / ended_user / paused。

要验证竞态（结束撞模型、旧租约、幂等重放），看 `tests/race-and-guards.test.js`，
每条都对应 `docs/agent-environment-design.md` 里的一条约束。

## 4. 用户既有规则（不要覆盖）

- 公众号内容抓取优先 `opencli weixin download`。
- 想法/灵感记录使用 thought-vault。
- 本仓库的工程规则**不覆盖**以上两条。

## 5. 提交前

```bash
npm run check
```

如果改了契约，同步更新：
- `renderer` 的字段使用（契约校验会挡住不一致）
- `docs/agent-environment-validation.md`（本轮实际跑出来的结果，不是"应该通过"）
