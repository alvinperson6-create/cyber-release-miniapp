# 赛博放生 · 单生物自主文字旅程 —— 新版设计（journey-v2）

更新：2026-09-29
对应 handoff：`product-history/2026-09-29-第一阶段-handoff.md`（2026-09-29 第一阶段）。本文描述**已实现**的架构与契约。
上一轮（四集故事 + 固定延时回信 + 广告解锁）的设计与证据保留在 `docs/jev-*` 与 `legacy/story-v0/`，不再描述现行系统。

## 1. 一句话架构

**LLM 是文字世界导演（临场提案/结算/执笔），JEV 是生物的行动决策脑（在合法候选中选择），程序是唯一权威账本（状态版本、原子提交、调度、预算、边界）。** 三者职责在每一次事件推进中闭环：

```
用户放生（原话+生物+水域+语气）
  ↓ 立即回执（preparing）
后台任务 opening：
  JEV 处境识别 → 本程动机档案（版本化）
  LLM 导演开局 → 生物轻量目标 + 首个遭遇提案（程序冻结）
  ↓
decide：JEV 在动态候选中选择行动（可先寄可回应信号 / 都不合适）
  ↓
settle：LLM 结算环境后果 → JEV 窄语义校验（行动/后果一致性 + 联系检查点）
  ↓ 原子落账：encounter.resolved + facts + 机制卡 + state_version+1
  ↓
contact：继续 / 阶段经历来信 / 自然收束来信（LLM 执笔，程序+JEV 边界检查后投递）
```

## 2. 数据模型（server/db.js，全新 schema）

| 表 | 职责 | 关键约束 |
| --- | --- | --- |
| `creatures` | 稳定生物身份（`CRT-*`），跨旅程保持 | 属于 owner_key；"同一只生物再次出发"的来源 |
| `journeys` | 一次出发（`JRN-*`）：状态机、语气、目标、`state_version`、`event_count` | `status`: preparing→active→(paused)/ended_user/ended_natural/(aborted) |
| `motivations` | 本程动机档案（原文+识别结果+证据句），每程独立 v1 起 | `pending/recognized/insufficient_evidence/degraded`，不伪装人格 |
| `encounters` | 遭遇：提案 JSON（程序冻结）+ JEV 决策 + LLM 结算 | `proposed→signal_sent→decided→resolved`；条件更新一次性提交 |
| `facts` | 追加式事实账本（地点/目标/承诺/资源/关系/未了之事/行动/后果/触发） | 只存故事确实用到的事实 |
| `mechanism_cards` | 机制卡：压力—两难—代价—持久后果 | 去重对象；跨旅程按 creature 保留最近 3 张 |
| `messages` | 信号 / 阶段来信 / 收束来信 / 用户回复 / 服务提示 | `sent_at` 支持安静时段/最小间隔的未来投递；视图只显示已到时消息 |
| `tasks` | 调度任务（opening/decide/settle/propose/signal_expiry/letter/final_letter/image/contact） | lease 租约 + due_at 公平队列 + 退避重试 + 幂等 |
| `model_calls` | 每次模型调用（LLM 与 JEV）的用量/时延/错误 | 预算（`J_MAX_MODEL_CALLS`）与成本审计依据 |
| `sessions` | 匿名会话：cookie token 的 sha256 → owner_key | 凭据不落库、不进日志 |

纪律：模型调用一律在事务外；提交用乐观锁（`state_version` 条件更新）与短事务；已提交记录有稳定 ID，失败/重试/重启不改写。

## 3. 核心契约

### 3.1 持续动机与同一生物（handoff §3.1）
- 放生先持久化并立即返回 `preparing` 回执；识别与开局在后台任务完成，界面如实显示"准备出发"。
- 动机档案以用户原话 + JEV 处境识别（证据句级）构成；识别不可用 → `degraded`（如实），不伪造档案做自主决策。
- 每次 JEV 决策输入 = 完整动机档案 + 生物目标 + 相关事实 + 合法候选 + **按时到达的用户补给**。留言是证据不是命令；"你可以拒绝"不会被程序化映射成永久拒绝。
- 同一 `creature_id` 可多次出发（`journey_id` 独立、动机档案新程新建）；归 owner 会话找回，不做跨设备承诺。

### 3.2 导演提案 / JEV 决策 / 程序结算（handoff §3.2）
- 提案必须含：处境、既有事实约束、**2-4 个动态生成的、有真实代价的**行动候选、机制摘要（压力/两难/代价）、预期事实类型。契约版本 `journey-director-v1`（`server/director.js`）。
- JEV 决策（`jev.js` SystemOne choice）：候选动作 + `none_fit`（触发**每遭遇至多一次**定向重提案；用尽则程序如实"搁下"，记 `none_fit_closed`，不伪装行动）+ `send_signal`（每遭遇至多一次）。
- **没有规则回退**：JEV 不可用 → 任务退避重试 → 超限旅程如实暂停（`task_retry_exhausted`），绝不把模板动作标成 JEV 行动。
- 结算：LLM 输出叙述+事实增量+机制卡；JEV 同请求做两件事——①行动/后果一致性 noul 检查（矛盾→一次修复→仍矛盾→重试/暂停）②联系检查点（continue/letter/final_letter，与①独立）。JEV 不可用时结算照常提交但 `outcome_status='unverified'`（如实），检查点降级为 continue（来源记录在案）。

### 3.3 两类联系、节奏与收束（handoff §3.3）
- **可回应信号**：冻结 encounter + 候选 + 状态版本 + 截止时间（截止由 JEV 同请求的紧急度分桶决定：3/10/30/60/120 分钟，程序持有映射与回退默认）；LLM 只就这件未决处境写简短信号；程序字面拦截"以回复施压"。用户按时回复 → 进入这件**尚未提交**的决策；不回复 → `signal_expiry` 任务到期唤醒同一遭遇，JEV 在原候选决策；同一遭遇不重复要信号；页面是否在线不影响。
- **迟到回复**：不改写已发生选择，存为 `late` 仅作本程后续未决参考；旅程已结束则明确拒绝。
- **经历来信**：只能叙述已提交事实；阶段信留悬念、收束信 `meta.isFinal` 并置旅程 `ended_natural`。发送时间尊重**安静时段**（默认本地 1-7 点顺延）与**最小间隔**（默认 2h）；投递前视图不可见。
- **用户结束**：立即生效（不等模型写结尾），取消全部任务，系统提示与生物来信严格区分。
- 最大静默护栏（默认 36h）触发联系检查点——这是服务护栏，不是伪装成生物自主行为。

### 3.4 去重与幽默边界（handoff §3.4）
- 程序字面比较（`textmatch.js` 字符 bigram Jaccard）+ 边界带一次 JEV 窄语义比较（"同机制换皮？"，有限候选 ≤3 卡）：**明显重播 → 每遭遇至多一次定向重提案**；可疑但不确定 → 日志 + `_meta.review='suspicious_similarity'` 进抽样评审，不拦截、不自动重写已公开内容。
- 机制卡跨本生物旅程保留（不是全局相似度库，不做用户可见故事档案）。
- 幽默边界三层：导演提示词规则（不贬低用户/不虚构用户事实/允许平静）→ 程序字面拦截（施压/贬低模式）→ JEV 窄语义 noul（编造用户事实/贬低/与账本冲突）。信件检查失败 → 一次修订 → 仍失败则**不公开**（withheld 重试），超限如实暂停。
- 语气偏好（轻一点/刚好/更荒唐一点）只影响**未来**提案荒诞度与文风，存于旅程行，改语气不动事实与旧信。

### 3.5 配图与成本（handoff §3.5）
- 文字先行：单程配图预算 `J_IMAGE_BUDGET`（默认 1），只在第一封阶段信或收束信尝试；生成非阻塞，失败/超预算仅标记 `image_status`，不影响读信。
- 预算护栏：`J_MAX_MODEL_CALLS`（默认 60/程，含 JEV）用尽 → `paused(budget_exhausted)` 如实显示。

## 4. 服务与安全
- 会话：`HttpOnly; SameSite=Lax` cookie（随机 32 字节 token），服务端只存 sha256 → `owner_key`。所有旅程读写按 owner 校验，他人/猜到的 ID 一律 404；客户端自报 openid 机制已废除。
- 渲染：H5 全部动态文本经 `esc()` 转义后插入；无 `eval`；无把模型文本拼入 `innerHTML` 的裸路径。
- 调度：`scheduler.tick()` 由 `index.js` 周期调用；租约过期自动回收（崩溃/重启恢复）；`reconcileJourneys` 为丢失任务的旅程补任务（幂等）；公平取用（due_at 升序 + 单旅程每 tick 限额）。
- 读取 API 绝不触发模型生成。
- 时钟：`server/clock.js` 可注入（离线测试用虚拟时钟全速验证状态机）；生产节奏由 `J_TIME_SCALE` 部署配置缩放。

## 5. API（v2，旧 API 见 §7）
| 方法/路径 | 说明 |
| --- | --- |
| `POST /api/release` | 放生/再出发（species, water, feeling, tone, creatureId?）→ 立即 `preparing` 回执 |
| `GET /api/journey/:id` | 本程视图：状态、目标、动机、待回应信号、已寄出信件（归属校验，只读） |
| `GET /api/journey/:id/timeline` | 旅程回顾时间线：开局→遭遇与选择→信号/回应/来信→收束，单线串起（**仅旅程结束后**；归属校验；纯读取零模型调用） |
| `POST /api/journey/:id/reply` | 回应信号（按时/迟到服务端判定） |
| `POST /api/journey/:id/tone` | 语气偏好（只影响未来） |
| `POST /api/journey/:id/end` | 结束本程（立即） |
| `GET /api/journeys` / `GET /api/creatures` | 旅程列表 / 生物列表（再出发入口） |
| `GET /api/world/pulse` | 只含累计数与最近水域，**不含任何用户原话** |
| `GET /api/health` | 健康检查（含版本号） |

## 6. H5（web-app.html，重写）
放生（3D 地球/2D 地图选水域 + 原话 + 生物 + 再出发开关 + 语气）→ 回执（准备出发，无倒计时无广告）→ 信箱（旅程切换、信号卡含倒计时与候选动作、信件时间线、语气调整、结束按钮，15s 只读轮询）。旧四集弹窗/广告解锁/回信时间选择/误导倒计时全部移除。

## 7. 已移除的旧入口（handoff §4.3/4.5）
`/api/destiny`（广告解锁）、`POST /api/reply/generate`、按 `reply_at` 预生成的调度、旧 `JOURNEY_ENABLED` 三节点旅程、`/api/records` 旧档案、世界脉搏中的用户原话片段——全部停挂；实现代码冻结在 `legacy/story-v0/`（含其 61 个旧测试快照）。真实小程序 `miniprogram/` 与 `cyber-release-miniapp.html` 为历史原型，本阶段未接入新版 API，不再作为可用入口展示。

### 5.1 旅程回顾时间线的披露边界
时间线只在旅程结束后开放：进行中全量公开遭遇会取消"生物自己选择何时来信"的意义（§3.3）。结束后所有信已寄出，展开无副作用；未落定的遭遇（如用户中途结束时挂在信号上的那件）如实标记"还没落定"。这是**单程内**的回顾视图，不是跨旅程故事档案（第二阶段边界不变）。

## 8. 明确不做（留给第二份 handoff）
生物相遇 + 共同世界；用户可见的跨旅程故事档案。本阶段的内部账本/消息/生物身份与"本程信箱"不是故事档案。
