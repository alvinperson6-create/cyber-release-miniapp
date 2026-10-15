# 赛博放生 · 运行手册（runbook）

本文件只放**实际可执行**的命令。设计理由见 `docs/agent-environment-design.md`，
本轮实际跑出来的结果见 `docs/agent-environment-validation.md`。

---

## 1. 环境准备

```bash
cd /Users/alvin/Desktop/02-项目/赛博放生

# Node ≥ 22
node -v

# 安装依赖
npm install

# 如果 better-sqlite3 报 NODE_MODULE_VERSION 不匹配（换过 Node 版本）：
npm rebuild better-sqlite3
```

> **常见坑**：`better-sqlite3` 是原生模块，编译时的 Node ABI 必须与运行时的 Node 一致。
> 如果 `npm run check` 报 `ERR_DLOPEN_FAILED`，先 `npm rebuild better-sqlite3`。

凭据放在 `data/.env`（已被 gitignore）：

```
PORT=3001
AI_PROVIDER=qianfan
AI_API_KEY=...
AI_BASE_URL=...
AI_MODEL=...
IMAGE_API_KEY=...      # 可选
IMAGE_BASE_URL=...
IMAGE_MODEL=...
JEV_API_KEY=...        # 决策判断；缺失时旅程会如实暂停，不用规则冒充
JEV_ENABLED=1
JOURNEY_ENABLED=1
```

---

## 2. 启动

```bash
# 生产启动（唯一实际启动入口）
npm start

# 等价于
node --env-file-if-exists=data/.env serving/entrypoints/start.js
```

启动后：

- H5：<http://localhost:3001/>
- API：<http://localhost:3001/api/health>

按 `Ctrl-C` 会优雅关闭（停调度 timer + 关数据库）。

> 导入 `serving/entrypoints/app.js` 或 `runtime.js` **不会**启动任何东西——
> 只有 `start.js` 会监听端口、启动 timer、初始化 DB。

---

## 3. 统一检查

```bash
npm run check          # 全部五项（推荐）
npm run check:fast     # 只跑依赖边界 + 契约（改代码过程中用）
npm test               # 只跑测试
npm run boundaries     # 只跑边界检查
```

`npm run check` 的五项（任一失败即返回非零并指出失败项）：

| # | 检查 | 内容 |
| --- | --- | --- |
| 1 | 依赖边界 | shared/renderer/serving 硬约束 + 检查器自测 |
| 2 | 共享契约 | 契约纯度、错误码映射、命令校验、响应校验 |
| 3 | 离线业务与装配 | 6 个 node:test 文件（59 项断言），零真实外部调用 |
| 4 | 固定场景 | 7 个场景都能进入并达到预期状态 |
| 5 | 前端静态与资源 | 入口、资源、接口路径、状态分离标记 |

证明边界规则确实会失败：

```bash
node tooling/boundary-check.js --self-test
```

---

## 4. 固定场景

```bash
node tests/scenarios/cli.js                   # 列出全部场景
node tests/scenarios/cli.js awaiting_signal   # 进入场景并打印摘要
node tests/scenarios/cli.js letter --http     # 额外走一次真实 HTTP 读取
node tests/scenarios/cli.js letter --step 60000
node tests/scenarios/verify-all.js            # 批量验证全部场景
```

| 场景 | 达到的状态 |
| --- | --- |
| `preparing` | 已建程，模型未产出目标 |
| `awaiting_signal` | 已寄出信号，等用户回应 |
| `settled` | 已完成一次决策与结算 |
| `letter` | 已寄出阶段来信，旅程继续 |
| `ended_natural` | 自然收束，回顾时间线开放 |
| `ended_user` | 用户主动结束 |
| `paused` | 模型连续失败后如实暂停 |

每个场景用**临时隔离库**，默认零真实外部调用；`reset` 只作用于该次数据。

---

## 5. 真实生产路径冒烟

```bash
node scripts/smoke-real.js            # 隔离库 + 真实凭据，会产生实际费用
node scripts/smoke-real.js --keep-db  # 保留隔离库便于复查
```

覆盖：建程 → 开局 → 推进 → 用户结束 → 回顾时间线。

**边界**：竞态与稀有分支的主要回归手段仍是固定场景；冒烟只证明主链在真实外部服务下走得通。
输出会明确区分「覆盖」与「未覆盖」；未覆盖不为空时会打印提示，
那表示**部分验证**，不是全部通过。

产物：`docs/agent-environment-validation-artifacts/smoke-real.json`

---

## 6. 数据库操作

```bash
# 位置：DB_PATH → CYBER_RELEASE_DB → data/data.db
node scripts/db-backup.js backup                          # → .workbuddy/backups/
node scripts/db-backup.js backup /tmp/snapshot.db
node scripts/db-backup.js verify /tmp/snapshot.db         # integrity + 逐表行数
node scripts/db-backup.js restore /tmp/snapshot.db         # 恢复前自动再备份
```

**不要直接 `cp data/data.db`**：WAL 模式下会丢掉 `-wal` 里未 checkpoint 的事务。

迁移是自动的（`PRAGMA user_version`），启动时执行，无需手动跑。
查看当前版本：

```bash
node -e "const {createStore}=require('./serving/adapters/store');const s=createStore({});s.initDb();console.log('schema version:',s.currentVersion(s.getDb()));s.closeDb()"
```

---

## 7. 故障定位

| 症状 | 可能原因 | 处理 |
| --- | --- | --- |
| `ERR_DLOPEN_FAILED` / `NODE_MODULE_VERSION` | 原生模块 ABI 不匹配 | `npm rebuild better-sqlite3` |
| 旅程一直 `paused`，提示 `task_retry_exhausted` | 文本模型或 JEV 不可用 | 看服务端日志的 `flow error`；检查 `.env` 凭据与网络 |
| **JEV 返回 451** `Typesafe is not available in your region` | **出口 IP 所在区域被 JEV 限制** | **换网络出口，别改代码**。设 `JEV_PROXY=http://127.0.0.1:<端口>`（端口查 `scutil --proxy \| grep -A2 HTTPSEnable`）。同一套代码曾在其他区域跑通，见 `docs/jev-validation.md` §2 |
| 旅程 `paused`，`pause_reason=budget_exhausted` | 单程模型调用预算耗尽 | 正常护栏；调整 `J_MAX_MODEL_CALLS` |
| `flow error: jev_unavailable` | JEV 未配置或返回错误 | 配置 `JEV_API_KEY`；**不要**用规则冒充决策 |
| 信号迟迟不寄出 | 真实 JEV 可能直接选择行动 | 这是真实行为，不是 bug；用 `awaiting_signal` 场景验证信号路径 |
| 静态资源 404 | 前缀不在白名单 | 检查 `serving/entrypoints/app.js` 的 `PUBLIC_ASSET_PREFIXES` |
| 私有路径能被访问（安全问题） | 边界被绕过 | 跑 `node tooling/boundary-check.js`；静态服务只挂载白名单前缀 |
| 前端一直"网络不太顺畅" | 服务未启动或契约不匹配 | `curl localhost:3001/api/health`；跑 `node tooling/frontend-check.js` |

### 看日志

服务端日志走 stdout/stderr。关注这几类：

```text
[db] migration vN (...) applied      # 迁移
[scheduler] task X(kind) ...         # 调度结果
[orchestrator] task X(kind) commit=stale (reason)   # 提交被复核拦下（正常）
[server] error: ...                  # 未预期错误
```

`commit=stale` / `commit=cancelled` 是**护栏正常工作**的证据，不是故障。

---

## 8. 常用开发循环

```bash
# 1. 改代码
# 2. 快检查（秒级）
npm run check:fast
# 3. 完整检查
npm run check
# 4. 手动看某个场景
node tests/scenarios/cli.js awaiting_signal
# 5. 真机验证（会花钱）
node scripts/smoke-real.js
```

改契约时的完整清单见 `AGENTS.md` §5。
