# 赛博放生 · 改造进度

日期：2026-10-15
交接：`docs/HANDOFF-Agent工程环境改造.md`

---

## 1. 阶段完成情况

| 阶段 | 交接要求 | 状态 | 说明 |
| --- | --- | --- | --- |
| **A** 基线、发布资源、生产共用装配 | ✅ 完成 | 记录基线 50 pass；静态收紧为白名单；`createApp(runtime)` 导入零副作用；生产/测试/场景共用同一装配；数据路径锚定 + 版本化迁移 + 一致性备份 |
| **B** 最小可复现验证底座 | ✅ 完成 | 实例级依赖注入（`createStore`/`createClock`/adapter 注入）；显式模型操作名（16 个）；7 个固定场景 + CLI 入口；默认零外部调用 |
| **C** 共享契约与命令幂等 | ✅ 完成 | `shared/contracts` 6 个纯模块；20 个错误码固定状态码；回复必须显式带 signal/encounter ID；4 类命令持久幂等（`(owner, operation, requestId)` 分域） |
| **D** Host 提交、调度与模型边界 | ✅ 完成 | commands/queries/workflows/context/policies/commits 拆分；提交结果 5 种语义；租约持有者条件；defer/retry 分离；统一模型入口（含注入 adapter 包装）；迟到参考链 |
| **E** Client 与消息卡片 | ⚠️ 部分 | 三段式状态分离 + 序号/代次闸门 + 非法响应拒绝 + 草稿按信号 ID + 命令后失效；**真实浏览器回归未执行** |
| **F** 自动检查、知识入口、归档 | ⚠️ 部分 | 统一 check（5 项）、边界检查器（6 类规则 + 自测）、CI、README、AGENTS.md、feature map、验证 Skill、模板、legacy 归档；**CI 远端强制未验证**、**效率待实测** |

---

## 2. 变更范围

### 新增

```
shared/contracts/         6 个纯模块（errors/enums/commands/vocabulary/dto/index）
serving/                  完整服务层（entrypoints 5 + adapters 6 + journey 5 组，共 17 文件）
renderer/                 index.html + assets/（vendor、globe 配置、90 张图片）
tests/                    6 个测试文件 + helpers + scenarios + fixtures
tooling/                  check / boundary-check / contracts-check / frontend-check / run-tests / templates
.github/workflows/        check.yml
AGENTS.md  README.md  docs/FEATURE-MAP.md
scripts/db-backup.js  scripts/smoke-real.js
docs/agent-environment-{design,runbook,validation,progress}.md
```

### 删除（已归档到 legacy/）

```
server/ai.js, db.js, director.js, orchestrator.js, index.js, routes/, public/ 等源码
cyber-release-miniapp.html, cyber-release-v2.html  →  legacy/html-prototypes/
verify-*.js, build-blind-eval.js                   →  legacy/scripts-v2/
web-app.html                                        →  renderer/index.html（git mv 保留历史）
server/node_modules                                 →  仓库根 node_modules
```

### 保留

```
server/data.db(+wal/shm)   原位未动（含旧四集数据）
server/.env                凭据，未提交
miniprogram/               globe-config 数据源
docs/jev-*/, journey-v2-*/ 历史验证与设计材料，未覆盖
handoff.md                 旧交接，未改日期与结论
```

---

## 3. 目录搬迁的连锁处理

| 事项 | 处理 |
| --- | --- |
| `server/public/*` → `renderer/assets/*` | `git mv` 保留历史；`createApp` 的白名单前缀不变，既有图片 URL `/images/<file>` 仍可达 |
| `server/node_modules` → 根 `node_modules` | 新增根 `package.json`；脚本统一从仓库根解析 |
| `server/.env` | 保留原位；`npm start` 用 `--env-file-if-exists=server/.env` |
| `sync-globe-config.js` | 输出路径改到 `renderer/assets/`；源缺失时**明确报错**而非静默生成空配置 |
| 旧 `verify-*.js` | 归档 + README 说明对应的新命令；不静默留断链脚本 |

---

## 4. 遗留事项与未验证项

| 项 | 类型 | 状态 | 补验方式 |
| --- | --- | --- | --- |
| 真实 JEV 决策/结算/来信 | 外部限制 | HTTP 451 地域限制，未验证 | 在可访问区域跑 `node scripts/smoke-real.js` |
| 真实浏览器回归 | 未执行 | 状态机已用最小 DOM 桩覆盖，真实浏览器未跑 | 接入 Playwright 到 `tests/browser/` |
| 真实配图 | 未触发 | 未配置 `IMAGE_*` | 配好凭据后寄一封阶段信 |
| CI 远端强制拦截 | 未验证 | workflow 已提交；branch protection 需在仓库设置里配 | 设置 `check` 为必需检查 |
| 效率收益 | 待实测 | 未做对照测量 | 用 `tooling/templates/efficiency-log-template.md` 记录 |
| TypeScript 类型检查 | 未做 | 交接列为可选而非验收项 | 契约层已有运行时校验 + 边界检查 |
| `snapshotVersion` | 未加 | 按交接要求需先验证再定义 | 当前用请求序号 + 失效机制达成等价效果 |

---

## 5. 环境约束改进（本轮固化的部分）

交接 §6 要求"发现问题后判断是否应将约束固化为 Skill／脚本／Lint／架构规则"。
本轮实际发生的案例见 `docs/agent-environment-validation.md` §7（11 项）。
按性质归类：

| 性质 | 本轮案例 | 固化到哪里 |
| --- | --- | --- |
| 机械操作 | 备份不能 `cp`（WAL 会丢数据） | `scripts/db-backup.js` + runbook 故障定位表 |
| 机械操作 | 场景进入方式不统一 | `tests/scenarios/cli.js` + `verify-all.js` |
| 可静态识别的违规 | 5 处 SQL 出现在非存储层 | `tooling/boundary-check.js` 的 `sql-only-in-store` |
| 可静态识别的违规 | 依赖跨层 | `shared-no-serving` / `renderer-no-serving` / `serving-no-legacy` |
| 不合法输入 | 契约层只判空不判取值 | `contracts-check.js` 的 9 类非法输入断言 |
| 不合法输入 | 缺回复目标被静默推断 | `parseReplyCommand` 强制要求目标 + 契约检查 |
| 重复越权写入 | 命令层直接查幂等表 | `store.readCommandResultIn()` + 边界检查禁止 SQL |
| 知识遗漏 | Node ABI 与原生模块不匹配 | runbook 故障定位表首条 |
| 知识遗漏 | `state_version` 不是前端快照版本 | 设计报告 §3.4 显式记录 |
| 验证工具自身出错 | 冒烟把"暂停"报成"未覆盖：无" | 冒烟脚本改为按实际发生记录，未覆盖时明确提示 |
| 依赖版本漂移 | 注入 adapter 绕过统一记账 | `runtime.js` 的 `withLedger()` 包装 + 测试断言 |

> 交接要求"不凑五类数量"。上表只列本轮**实际发生**的案例。

---

## 6. 一条经验

**验证工具自己出错，比没有验证更危险。**

本轮 `scripts/smoke-real.js` 初版在旅程因 JEV 不可用而暂停时，
输出"未覆盖：（无）"——把"根本没验证到决策路径"说成了"没有遗漏"。
这是 §7 第 11 条。修正后它会区分：

- 覆盖：真实走到的路径
- 未覆盖：真实模型没走到或外部服务不可用的路径

并且明确打印「这是部分验证，不是全部通过」。

下一位 Agent 如果扩展验证脚本，请保持这个纪律：
**工具报"通过"之前，先确认它真的验证了那件事。**

---

## 7. 交付清单对照

| 交接 §7 验收项 | 状态 | 证据 |
| --- | --- | --- |
| 现有产品行为及 journey-v2 数据保留，数据库路径迁移有验证 | ✅ | 旧库 54+54 行保留；路径锚定测试 |
| 公开资源明确，源码/运行数据/legacy/fixture 控制不公开 | ✅ | `race-and-guards` 静态安全用例（9 条私有路径全部不可达） |
| 生产与测试共用无启动副作用的装配入口，依赖与资源可独立关闭 | ✅ | `app-assembly.test.js` 5 项 |
| 固定场景可复现，默认零真实外部调用，模型桩与提示词文案解耦 | ✅ | 7 场景；操作名显式白名单 |
| 共享契约、信号目标和持久命令幂等落实，所有调用方同步更新 | ✅ | 契约检查 + 4 类幂等用例 + 前端带目标 |
| 统一提交挡住结束、补给、版本和旧租约竞态，原子排程与重启恢复正确 | ✅ | `race-and-guards` 7 项 |
| 正常等待与失败重试分开，所有实际模型调用进入相应预算和台账 | ✅ | defer 用例 + 预算台账用例 |
| Client 分离副本与临时状态，真实浏览器验证晚回、草稿和展开状态 | ⚠️ | 状态机已覆盖；真实浏览器未跑 |
| 实际依赖边界、类型/契约、必要回归和构建由统一 check/CI 执行 | ✅ | 5/5 通过 + workflow 已提交 |
| README、AGENTS.md、feature map、验证 Skill 和模板可被下一位 Agent 直接使用 | ✅ | 见仓库根与 docs/ |
| 历史入口/资料归档清晰，现行资源脚本没有依赖断链 | ✅ | legacy/README + sync-globe-config 明确报错 |
| 真实冒烟结果如实记录；缺凭据或未触发分支明确列出，不被 fixture 结论替代 | ✅ | validation §5，含 JEV 451 根因 |
| 效率收益有实测及限制，或明确待实测并交付记录方法 | ✅（待实测） | 已交付记录模板，未编造数字 |
