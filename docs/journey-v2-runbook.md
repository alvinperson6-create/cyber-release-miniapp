# 赛博放生 · journey-v2 运行手册

更新：2026-09-29
适用：`server/`（journey-orchestrator-v2）。上一轮运行手册见 `docs/jev-runbook.md`（历史）。

## 1. 启动

```bash
cd server
node --env-file=.env index.js
# 默认 http://localhost:3001；H5 即 http://localhost:3001/
```

`.env` 关键项（v2 新增/沿用）：

```ini
AI_PROVIDER=qianfan          # openai | claude | doubao | qianfan
AI_API_KEY=...               # 文本模型（未配置则旅程无法开局，如实失败）
AI_MODEL=deepseek-v4-flash-0731
JEV_API_KEY=...              # 行动决策脑（缺失 → 决策重试后旅程如实暂停）
IMAGE_API_KEY/IMAGE_BASE_URL/IMAGE_MODEL=...   # 可选配图
JOURNEY_ENABLED=1            # v2 缺省开启；'0' 为停用后门
```

## 2. 服务护栏（全部可环境变量覆盖，见 `server/flags.js`）

| 变量 | 默认 | 含义 |
| --- | --- | --- |
| `J_SIGNAL_DEADLINE_MS` | 6h（可缩放） | 信号截止的**回退值**——正常由 JEV 紧急度分桶决定（3/10/30/60/120 分钟，随 `J_TIME_SCALE` 缩放），答案无效/缺失时使用 |
| `J_MAX_SILENCE_MS` | 36h | 最大静默 → 触发联系检查点 |
| `J_MIN_INTERVAL_MS` | 2h | 两封用户面向消息的最小间隔 |
| `J_QUIET_START` / `J_QUIET_END` | 1 / 7 | 安静时段（本地时），信顺延投递；设相等值关闭 |
| `J_MAX_EVENTS` | 12 | 单程遭遇上限（达到即走自然收束信，来源标记 `event_budget`） |
| `J_MAX_MODEL_CALLS` | 60 | 单程模型调用预算（含 JEV）；用尽 → `paused(budget_exhausted)` |
| `J_MAX_TASK_ATTEMPTS` | 4 | 任务重试上限；超限 → 旅程暂停（`task_retry_exhausted`） |
| `J_IMAGE_BUDGET` | 1 | 单程配图张数（0 关闭） |
| `J_LEASE_MS` / `J_TICK_MS` | 5min / 10s | 任务租约 / 调度周期 |
| `J_TIME_SCALE` | 1 | 时长缩放（部署/演示配置；600 ≈ 全部节奏×1/600） |

> 这些是程序拥有的服务护栏，不是用户拍板的剧情长度或发送日期（handoff §1）。

## 3. 验证与测试

```bash
# 离线测试（桩模型+桩 JEV+虚拟时钟+隔离 DB；39 用例）
cd server && DB_PATH=/tmp/test.db node --test ../tests/*.test.js

# 真实生产路径验证（真实 HTTP+文本模型+真实 JEV+真实 SQLite；子进程可重启）
node scripts/verify-journey-v2.js
# 产物：docs/journey-v2-eval/{trace.json,summary.json}
```

真实路径验证的节奏用 `J_TIME_SCALE=600` 缩放（部署配置，非测试专用决策逻辑）；离线测试则用注入虚拟时钟（`server/clock.js`）覆盖同一套状态机。两者互补。

## 4. 运维要点

- **旅程暂停（paused）**：`pause_reason` ∈ `budget_exhausted | task_retry_exhausted`。这是如实降级，不是生物收束；界面上有"服务提示"消息与生物来信明确区分。处理：检查 AI/JEV 余额与网络后，用户可让该生物再次出发（旧程保留可读）。
- **重启恢复**：任务有租约（`J_LEASE_MS`），进程崩溃后到期自动回收；`reconcileJourneys` 为缺任务的旅程补发（幂等，不产生双事件）。已验证：真实 SIGTERM → 同 DB 重启 → 旅程继续（见 `docs/journey-v2-eval/trace.json` restarts）。
- **对账/审计**：`model_calls` 表记录每次调用（kind/model/usage/latency/status）；`encounters.decision_source` 记录每次行动来源（`jev` / `jev_after_reproposal`）；`outcome_status='unverified'` 表示结算未经 JEV 一致性检查（JEV 当时不可用，如实标记）。
- **抽样评审**：`encounters.proposal_json` 里 `_meta.review='suspicious_similarity'` 表示提案相似度可疑但未拦截，供人工抽样。
- **配图**：`messages.image_status` ∈ done/failed/budget_exhausted；失败不影响文字。
- **数据边界**：测试/验证务必用独立 `DB_PATH`；会话 cookie 值与 API key 不进日志；用户原话只存于其自己的旅程行。

## 5. 已知限制（如实）

- 真实模型偶发提案结构不合规：有归一化 + 携带错误的一次定向修订 + 任务级退避重试；连续失败会旅程暂停（可观测）。
- 字面去重对"同模板换主语"有效；语义级深度换皮依赖边界带 JEV 窄比较与抽样评审，存在漏检可能。
- `outcome_status='unverified'` 的结算表示一致性未经 JEV 复核（JEV 故障时的如实降级）。
- 小程序与 `cyber-release-miniapp.html` 未接入 v2，已从新版叙事中除名（历史原型）。
