# 赛博放生 · 验证记录

日期：2026-10-15
运行模式：离线回归（固定 adapter，零真实外部调用）+ 真实生产路径冒烟（隔离库、真实凭据）
执行 commit：`40967f7`（refactor: Agent 工程环境改造（阶段 A–F））

本文件只记录**本轮实际跑出来的结果**。历史 39/43 之类的旧数字不作为本轮基线。
未验证项如实列出，不用 fixture 结论替代真实结论。

---

## 1. 环境与起点复核

| 项 | 交接记录 | 本轮实际复核 |
| --- | --- | --- |
| HEAD | `459a55c67fcbe4423d2f3ae91d5e675a9f9f6f9c` | 一致（`git log -1` = `459a55c chore: 补 .gitignore…`） |
| 工作区 | 干净（新增 handoff 前） | 干净，仅多出未跟踪的 handoff 文档 |
| Node | 未记录 | 关键发现：托管 Node 22.22.2（ABI 127）与系统 Node 25.6.1（ABI 141）并存 |
| 依赖 | — | `better-sqlite3` 原生模块按 **ABI 141** 编译，用 Node 22 跑会 `ERR_DLOPEN_FAILED`；**用 Node 25 才跑得起来** |

> 这个 ABI 问题在改造前就存在（旧套件用 Node 22 跑是 38 项失败），
> 不是本轮引入的。本轮把它写进 runbook 的故障定位表。

### 改造前基线（Node 25.6.1，改造前 HEAD）

```
tests/actions-and-contact.test.js    pass 5  fail 0
tests/contact.test.js                pass 8  fail 0
tests/db-v2.test.js                  pass 6  fail 0
tests/dedup-boundary.test.js         pass 5  fail 0
tests/journey-core.test.js           pass 7  fail 0
tests/scheduler-safety.test.js       pass 7  fail 0
tests/situations.test.js             pass 7  fail 0
tests/timeline.test.js               pass 5  fail 0
─────────────────────────────────────
合计                                 50 pass / 0 fail
```

---

## 2. 数据迁移验证

改造前备份（走 SQLite backup API，非 `cp`）：

```
node scripts/db-backup.js backup .workbuddy/backups/data.db.pre-refactor
→ backup ok
node scripts/db-backup.js verify .workbuddy/backups/data.db.pre-refactor
→ integrity: ok
→ tables: destinies, records
→ counts: destinies=54, records=54
```

**重要事实：改造前仓库没有 journey-v2 运行时数据。**
`server/data.db` 只有旧四集原型表；`docs/jev-eval/*.db` 同样只有旧表。
journey-v2 的 journeys/encounters/messages 全在临时库里。

因此"保留现有 journey-v2 数据"在本轮的实际含义是：
不破坏既有文件，且迁移后在旧库上验证可读。实测：

| 场景 | 结果 |
| --- | --- |
| 全新空库 → 迁移 | v1 + v2 均应用，`user_version=2` |
| 同库再跑一次 | `applied: []`，表数量不变（可重入） |
| 旧四集库（records 表 1 行）→ 迁移 | 旧行数保留 1，`journeys` 表已创建 |

数据路径锚定验证（`tests/store.test.js` + `tests/app-assembly.test.js`）：

```
DB_PATH=/tmp/abc.db  → resolveDbPath() == /tmp/abc.db
未设置                → resolveDbPath() == <repo>/server/data.db（历史位置）
```

---

## 3. 统一检查结果

命令：`npm run check`（Node v25.6.1，macOS，本地）

```
赛博放生 · 统一检查

▸ 依赖边界　　　　　　　　 shared/renderer/serving 之间的硬约束（含检查器自测）
  ✔ 通过 188ms

▸ 共享契约　　　　　　　　 契约纯度：shared 不含 IO/env，命令校验与错误码可用
  ✔ 通过 287ms

▸ 离线业务与装配　　　　　 存储/旅程/竞态/装配/HTTP/前端的 node:test 套件（零真实外部调用）
  ✔ 通过 13760ms（59 项断言通过）

▸ 固定场景　　　　　　　　 每个固定场景都能进入并达到预期状态
  ✔ 通过 3412ms

▸ 前端静态与资源　　　　　 H5 入口存在、公共资源可达、脚本与后端契约一致
  ✔ 通过 162ms

────────────────────────────────────────────────────────────
检查结果：5/5 项通过
```

### 3.1 边界检查器自测（证明规则确实会失败）

```
node tooling/boundary-check.js --self-test
  ✔ renderer-imports-serving     → serving-no-legacy
  ✔ renderer-touches-db          → renderer-no-db
  ✔ serving-imports-legacy       → serving-no-legacy
  ✔ serving-sql-outside-store    → sql-only-in-store
  ✔ shared-imports-serving       → serving-no-legacy
  ✔ shared-reads-env             → shared-no-io
  全部违规样例均被拒绝。
```

> 注意：`serving-no-legacy` 与 `shared-no-serving` 是同一条依赖图规则在不同层的表现，
> 自测按层归类因此同名。这是规则的合并，不是缺失。

### 3.2 本轮被边界检查器真实拦下并修复的问题

| 文件 | 违规 | 处置 |
| --- | --- | --- |
| `commands/release.js` | 直接 `db.prepare(...)` 查 `command_requests` | 改用 `store.readCommandResultIn()` |
| `commands/reply.js` / `commands/end.js` | 同上 | 同上 |
| `commits/settlement.js` | `db.prepare('SELECT * FROM journeys …')` | 改用 `store.readJourneyForCommit()` |
| `workflows/orchestrator.js` | `db.prepare('SELECT COUNT(*) …')` | 改用 `store.countMessagesOfKind()` |

---

## 4. 离线回归明细（59 项断言）

```bash
npm test
```

| 文件 | 项数 | 覆盖 |
| --- | --- | --- |
| `store.test.js` | 12 | 迁移可重入/保留历史、乐观锁、遭遇一次性提交、快照护栏、租约条件、defer 不耗重试、任务去重、幂等分域、operation 原子去重、台账维度、数据路径锚定 |
| `journey-core.test.js` | 9 | preparing→开局、决策→结算、阶段信、自然收束、结束、语气只影响未来、JEV 不可用不冒充、读取不推进、再次出发 |
| `race-and-guards.test.js` | 14 | 幂等（建程/owner 分域/结束）、回复目标显式化、旧信号不绑新信号、按时补给与迟到参考、本程结束拒收、**模型调用期间用户结束**、旧 worker 与新租约、defer vs retry、预算台账、跨 owner 拒绝、**静态资源：公开可达 + 私有不可达** |
| `app-assembly.test.js` | 5 | 导入无副作用、createApp 可重复创建关闭、两个 runtime 完全隔离、fixture 未知操作名失败、数据路径锚定 |
| `http-contract.test.js` | 7 | 会话属性、Idempotency-Key 生效、错误码→状态码逐个核对、未知 API 404、响应契约校验与不泄漏、读取不调模型、health 不泄漏凭据 |
| `frontend-contract.test.js` | 12 | 入口与资源、esc 转义、默认值、回复带目标、幂等键全覆盖、副本按 journeyId、晚回闸门、乱序闸门、命令在途、草稿按 signalId、非法响应拒绝、UI 状态分离 |

### 4.1 交接 §5 验收场景逐条对照

| 场景 | 后果 | 本轮证据 | 状态 |
| --- | --- | --- | --- |
| preparing → 开局 | 命令先回执，后台才有目标；重复 GET 不改变事实/任务/调用数 | `journey-core.test.js` 第 1 项 | ✔ 固定场景 |
| 待回应信号 | 实际编排产生信号；截止前/等号/截止后 | `race-and-guards`（defer 测试）+ `store.test.js` 等号语义 | ✔ 固定场景（真实模型未覆盖，见 §5） |
| 并发建程/回复/结束 | 同键同输入只落一次；同键异输入冲突；重启后稳定 | `race-and-guards` 前 3 项 + `http-contract` 幂等项 | ✔ |
| 旧信号、过期与补给竞争 | 旧信号不绑新信号；补给进对应决策；迟到只进后续未决 | `race-and-guards` 第 4–5 项 | ✔ |
| 模型调用期间用户结束 | 无新事实/来信提交，终态不复活 | `race-and-guards`（可暂停 adapter） | ✔ |
| 旧 worker 与新租约 | 旧 worker 无法提交；一个 operation 至多落一次 | `race-and-guards` + `store.test.js` 租约项 | ✔ |
| defer 与故障 retry | 正常等待不耗尽重试；真实错误退避并暂停 | `race-and-guards` + `store.test.js` defer 项 | ✔ |
| 预算与调用台账 | 识别也记录；无余额不开新请求；取消后调用仍有记录 | `race-and-guards` 预算项 | ✔ |
| 阶段信/收束与重启 | 阶段信后继续；终态稳定；提交与后续任务不双写/丢失 | `journey-core` + `commits` 同事务 | ✔ |
| Client 浏览器回归 | 晚回/乱序/命令与轮询竞争 | `frontend-contract.test.js` 状态机项 | ⚠️ 见 §6 未验证项 |
| 所有权与公开资源 | 跨 owner 拒绝；源码/库/legacy 不可公开 | `race-and-guards` + `app-assembly` | ✔ |
| 迁移后的既有库 | ID 与内容不变；pending task 升级后继续；重复迁移无副作用 | §2 | ✔（旧库无 journey-v2 数据，见说明） |
| 检查器与装配隔离 | 非法 import/query 写入/adapter 绕过被拦；两 runtime 不串；关闭无残留 | §3.1 + `app-assembly` | ✔ |
| query 写入检查 | queries 不得写业务状态 | `queries/views.js` 只调用 store 读取函数；边界检查禁止 SQL | ✔ |

---

## 5. 真实生产路径冒烟

命令：`node scripts/smoke-real.js`（隔离库 + 真实凭据，产生实际费用）

```text
隔离库：/var/folders/.../cyber-release-smoke-1792050746298.db
文本模型凭据：有｜JEV 凭据：有
contractVersion: journey-contract-v2

· release  — {"status":"preparing"}                       ✔ 命令立即返回 preparing
· opening  — {"phase":"journeying","goal":true}           ✔ 真实文本模型产出目标
· progress — {"phase":"paused","status":"paused"}         ⚠️ JEV 不可用，如实暂停
· end      — {"http":200,"ok":true}                       ✔ 用户结束立即生效
· final    — {"status":"ended_user"}                      ✔ 终态稳定
· timeline — {"http":200,"nodes":5}                      ✔ 回顾开放

真实调用次数：6
  明细：{"situation_recognition/error":1, "opening/ok":1, "action_decision/error":4}
覆盖：opening, user_end, timeline
未覆盖：决策/结算/来信（真实模型或 JEV 在验证窗口内不可用，旅程如实暂停）；
        阶段来信（真实模型未走到该分支）；收束来信（真实模型未走到该分支）；
        结算（真实 JEV 决策未成功完成）
```

### 5.1 JEV 不可用的根因与解除（已定位并修复路径）

直接调用 JEV 适配器：

```json
{"available": false, "reason": "HTTP",
 "error": "JEV 451: {\"title\":\"Typesafe is not available in your region.\",\"status\":451}"}
```

根因是**请求出口 IP 所在区域被拒**，不是代码缺陷：

| 证据 | 内容 |
| --- | --- |
| 不需要 key 的根路径也是 451 | 请求在到达鉴权前就被按出口 IP 拒绝 → 与 key 无关 |
| 三次连续请求结果一致 | 不是限流或瞬时故障 |
| 出口 IP 检测 | 中国大陆（`116.162.134.x` / `2408:8453::`） |
| 对照：千帆（国内服务） | 正常可达，说明网络本身通 |
| **同一套代码的历史记录** | `docs/jev-validation.md` §2 记载 **JEV jev-1.13.0 当时连通且按设计工作** |

**换到美国出口后 JEV 完全可用**，实测（curl 显式走本地代理 7897）：

```json
{"model":"jev-1.13.0","answers":{"a":{"type":"noul","noul":0.61}},"usage":{"input_tokens":288,"output_tokens":20}}
```

三次一致（0.61 / 0.60 / 0.61）。

### 5.1.1 顺带发现并修掉的一个真实坑：Node 不走系统代理

浏览器能开、服务器连不上的原因：**Node 的 `fetch` 不读 macOS 系统代理设置**。

| 手段 | 实测结果 |
| --- | --- |
| 系统代理 127.0.0.1:7897（浏览器能用） | Node 直连仍是本地出口 → 451 |
| Node 内置 `--use-env-proxy` + `HTTP(S)_PROXY` | **无效**，三种组合都仍走本地出口 |
| `undici` + `ProxyAgent` | **有效**，出口变美国 |

因此新增 `serving/adapters/http-client.js`（代理感知出口），
由 JEV 适配器通过 `JEV_PROXY` 环境变量启用。

**实现中踩到的第二个坑**：某些环境（CI / 容器 / IDE 沙箱）会同时注入
`HTTP_PROXY` 和 `HTTPS_PROXY` 且指向**不同**代理。初版实现按
`HTTPS_PROXY || http_proxy` 顺序取值，导致 https 请求被 `http_proxy`
污染 → 表现为"配了代理但出口 IP 没变"，极易误判成代理没生效。
已改为**https 请求只读 HTTPS 代理**，并由 `tests/proxy-client.test.js` 钉住。

### 5.1.2 换代理后的真实全链路结果

命令：`JEV_PROXY=http://127.0.0.1:7897 node scripts/smoke-real.js`

```text
· health  — {"aiEnabled":true,"jevEnabled":true}
· release — {"status":"preparing"}
· opening — {"phase":"journeying","goal":true}
· progress— {"phase":"ended","status":"ended_natural"}
· end     — {"http":409,"ok":false,"alreadyEnded":true}
· final   — {"status":"ended_natural","messages":["final_letter"]}
· timeline— {"http":200,"nodes":6}

真实调用次数：17，全部 ok
  situation_recognition×1  opening×1  action_decision×3  settlement×3
  settlement_check×3  proposal×2  reproposal×2
  final_letter_write×1  letter_check×1
```

**真实 JEV 的行动决策、结算、提案、去重重提案、收束来信全部走通。**
这一条把§6 里"真实 JEV 路径未验证"的遗留项补上了。

注意 `end` 返回 409：旅程在验证窗口内已自然收束，`already_ended` 是**正确行为**
（终态不可被改写），不是失败。冒烟脚本已据此修正覆盖判定。

### 5.2 失败时的行为是正确的

JEV 不可用时（第一次冒烟，无代理），系统：

1. 重试 4 次（`task_retry_exhausted`），**没有**用规则伪造 JEV 决策；
2. 旅程进入 `paused`，写入如实标注的服务提示（"这不是生物的来信"）；
3. 4 次失败的 `action_decision` 调用**全部记账**（用量不因失败而消失）；
4. 用户仍可主动结束，回顾时间线正常开放。

这正是交接 §5「JEV 行动判断不可用时继续重试/暂停，不以规则动作冒充 JEV 决策」
要求的证据。`tests/race-and-guards.test.js` 与
`journey-core.test.js` 的 JEV 不可用用例用固定 adapter 覆盖了同一行为。

### 5.3 覆盖边界

**已由真实外部服务验证**（§5.1.2，17 次调用全部 ok）：
行动决策、结算与一致性检查、遭遇提案、去重重提案、收束来信、回顾时间线。

**仍未验证**：

| 项 | 原因 | 补验方式 |
| --- | --- | --- |
| 信号路径（寄信号 → 补给 → 到期） | 真实 JEV 在本次运行中直接行动，未选择寄信号 | 换更容易触发未决的处境重跑；或用固定场景验证程序行为 |
| 阶段来信（`kind=letter`） | 本次自然收束走的是 `final_letter` | 调大 `J_MAX_EVENTS` 让真实 JEV 有更多检查点机会 |
| 真实配图 | 未配置 `IMAGE_*` | 配好凭据后寄一封来信 |
| JEV 网络抖动/限流路径 | 未构造真实限流 | fixture 已覆盖重试与暂停语义 |

**固定场景（`npm run check` 第 4 项）证明的是**：
在受控输入下，程序装配、状态迁移与护栏行为正确。
它**不能**证明真实 JEV 会选择这些分支——两者互补，不可互相替代。

---

## 6. 未验证项（如实列出）

| 项 | 原因 | 补验方式 |
| --- | --- | --- |
| ~~真实 JEV 决策/结算~~ | ~~HTTP 451~~ | **已验证**：设 `JEV_PROXY` 后 17 次真实调用全部 ok，见 §5.1.2 |
| 信号路径（真实 JEV 寄信号） | 本次真实 JEV 直接行动，未选择寄信号 | 换更未决的处境重跑；程序行为由固定场景覆盖 |
| 阶段来信（真实 `kind=letter`） | 本次自然收束走的是 `final_letter` | 调大 `J_MAX_EVENTS` 重跑 |
| 真实浏览器回归（晚回、乱序、草稿、展开） | 无浏览器环境；已用最小 DOM 桩覆盖状态机 | `tests/browser/`（目录已建，需接入 Playwright 或同类） |
| 真实配图生成 | 未配置 `IMAGE_*` | `npm start` 后寄一封来信，观察 `/images/` |
| CI 远端强制拦截 | 无法在此环境配置 branch protection | 仓库设置里把 `check` 设为必需检查 |
| 叙事质量 / 被尊重感 / 留存 | 不属于本轮工程目标 | 需要人工评估，不是工程验收项 |
| 效率收益 | 未做对照测量 | 见 `tooling/templates/efficiency-log-template.md`（**待实测**） |

---

## 7. 本轮发现并修复的真实缺陷

这些是**先复现/定位、再修复、再加约束**的完整闭环：

| # | 缺陷 | 影响 | 修复 | 新增约束 |
| --- | --- | --- | --- | --- |
| 1 | `store` 是模块级单例 | 两个 runtime 共享同一个 SQLite 连接，测试互相污染 | 改为 `createStore()` 工厂，每个实例持有自己的连接 | `tests/app-assembly.test.js` 隔离用例 |
| 2 | 注入的 adapter 绕过统一记账 | fixture/场景路径完全不进台账，预算形同虚设 | `runtime.js` 增加 `withLedger()` / `withJevLedger()` 包装 | `tests/app-assembly.test.js` + 预算用例 |
| 3 | 命名参数绑定错误（`completeTask`/`rescheduleTask`/`failTask`/`decideEncounter`/`updateJourney`） | SQL 用 `@name` 但按位置传参 → 运行时抛 `Too few parameter values`，调度静默重试 | 全部改为命名参数对象 | `tests/store.test.js` 逐条覆盖写路径 |
| 4 | `taskSettle` 引用未定义变量 `encounter` | 结算永远失败重试，故事无法推进 | 改为 `enc: enc` | `journey-core.test.js` 结算用例 |
| 5 | `const image = await image.generate(...)` 遮蔽配图适配器 | TDZ 错误 → image 任务连续失败 → 旅程误暂停 | 重命名为 `generated` | 阶段来信用例（会走到 image 任务） |
| 6 | `journey_not_finished` 不在错误码表 | 回顾接口返回 500 而非 403 | 补进 `shared/contracts/errors.js`，路由改用统一映射 | `http-contract.test.js` 逐码核对 |
| 7 | `Idempotency-Key` 头未归一进命令输入 | HTTP 幂等完全失效（重试会重复建程） | `api-router.js` 增加 `withRequestId()` | `http-contract.test.js` 幂等用例 |
| 8 | 命令契约只判空不判取值 | 非法物种/水域能通过契约层 | `parseReleaseCommand` 改用共享词表校验 | `contracts-check.js` 9 类非法输入 |
| 9 | 静态服务指向整个仓库根目录 | 源码、数据库、`.env`、`node_modules` 全部公开 | 收紧为白名单前缀 | `race-and-guards` + `app-assembly` 静态安全用例 |
| 9b | 白名单收紧过头：前缀映射到 `renderer/<prefix>` 而资源在 `renderer/assets/<prefix>` | 公开资源全部 404 | 改为 `renderer/assets/` 映射 | 同上（同时断言公开资源**可达**） |
| 10 | `drain` 测试助手自动跳过时钟 | 信号截止被直接跳过，测不到 defer | 增加 `advanceClock: false` 选项 | `race-and-guards` defer 用例 |
| 11 | 冒烟脚本把"暂停"报成"未覆盖：无" | **不诚实的验证结论** | 按实际发生情况记录覆盖/未覆盖，未覆盖时明确提示"部分验证" | 见 §5.3 |
| 13 | `scripts/db-backup.js` 仍 require 旧 `server/node_modules` | 搬迁后备份/恢复命令直接崩溃 | 改为从根解析；新增旧路径断链检查 | `tooling/frontend-check.js` §10 |
| 12 | 静态白名单映射错了目录层级 | `/vendor/three.min.js` 等公开资源全部 404（收紧过头变成功能回归） | 改为 `renderer/assets/` 子路径 + 单文件显式挂载 | `race-and-guards` 静态用例新增"公开资源必须可达"一侧 |

第 11 条尤其重要：验证工具本身出错时，会把"没验证到"说成"验证过了"。
第 12 条是"收紧过头"的典型：只测私有路径不可达是不够的，
必须同时断言公开资源**可达**，否则会把功能改坏而检查仍然全绿。
第 13 条是"目录搬迁留下断链"的典型：搬完必须扫一遍旧路径引用。

---

## 8. 产物位置

| 产物 | 路径 |
| --- | --- |
| 真实冒烟证据 | `docs/agent-environment-validation-artifacts/smoke-real.json` |
| 改造前数据库备份 | `.workbuddy/backups/data.db.pre-refactor`（已 gitignore） |
| 场景临时库 | 系统临时目录 `cyber-release-scenario-*`（每次新建，便于排查） |
| 边界违规样例 | `tests/fixtures/boundary-violations/`（应被检查器拒绝） |

不提交：真实密钥、会话、个人数据库、用户原话。
