---
name: verify-cyber-release
description: 赛博放生仓库的验证流程。当需要验证某个改动、复现某个旅程状态、排查竞态或回归时使用。覆盖固定场景进入、证据收集、失败定位与判断边界。
---

# 赛博放生 · 验证流程

这份 Skill 说明**怎么验证**，不替代 `AGENTS.md`（那里是改动规则）。
每一步都给可执行命令，不写"请自行验证"。

## 0. 判断该用哪种证据

先想清楚你要证明什么，再选手段：

| 你想证明的 | 用什么 | 不够用什么 |
| --- | --- | --- |
| 程序装配/状态迁移/护栏正确 | 固定场景 + 单元测试 | 真实模型冒烟 |
| 竞态不会丢数据 | `tests/race-and-guards.test.js` | 手工点几下 |
| 依赖边界没被破坏 | `npm run boundaries` | 代码评审 |
| 真实外部服务下走得通 | `node scripts/smoke-real.js` | 固定场景 |
| 叙事好不好笑、有没有被尊重感 | 人工评估 | 任何自动化 |

**固定场景不能替代真实模型**：它证明受控输入下程序正确，
不能证明真实 JEV 会选择那个分支。

## 1. 复现一个旅程状态

```bash
# 列出全部场景
node tests/scenarios/cli.js

# 进入某个场景，拿到 journeyId 与隔离库路径
node tests/scenarios/cli.js awaiting_signal
```

输出含 `journeyId`、`dbPath`、`status`、`phase`、`messages`、`modelCalls`、
`externalCalls: 0`。`dbPath` 指向系统临时目录，可以直接用 SQLite 打开看真实数据。

想手动推进：

```bash
node tests/scenarios/cli.js settled --step 60000     # 推进 60 秒并跑一个调度周期
node tests/scenarios/cli.js letter --http           # 额外走一次真实 HTTP 读取
```

需要交互式观察就用 `tests/scenarios/index.js` 的 `startScenario()`：

```js
const { startScenario } = require('./tests/scenarios');
const s = await startScenario('awaiting_signal');
console.log(s.summary());
await s.step(60e3);
await s.reset();
```

## 2. 跑完整验证

```bash
npm run check      # 五项：边界 → 契约 → 业务 → 场景 → 前端
npm run check:fast # 改代码过程中的快子集
npm test           # 只跑测试
```

`npm run check` 失败时会指出是哪一项、失败在哪，并把退出码置非零。

## 3. 收集证据

改完之后至少留这四样：

1. **命令与结果**：`npm run check` 的完整输出（含 5/5 计数）
2. **执行 commit**：`git rev-parse HEAD`
3. **场景摘要**：`node tests/scenarios/cli.js <场景>` 的 JSON
4. **真实调用明细**（如果跑了冒烟）：`docs/agent-environment-validation-artifacts/smoke-real.json`

汇总写进 `docs/agent-environment-validation.md`，**不要覆盖历史日期与结论**。

## 4. 失败处理

按性质处理，不要只加提示词：

| 现象 | 先做 | 再固化 |
| --- | --- | --- |
| 测试红 | 复现 → 定位根因 → 修 | 加一条覆盖该情况的测试 |
| 依赖跨界 | 看 `tooling/boundary-check.js` 的规则 | 改代码，**不要放宽规则** |
| SQL 出现在非存储层 | 同上 | 移到 `store.js` |
| 契约不一致 | 跑 `tooling/contracts-check.js` | 改调用方，不要在服务端兼容 |
| 场景达不到预期 | 打印 `world.store.getJourney()` 等真实状态 | 判断是 fixture 错了还是程序错了 |
| 真实模型不可用 | 看 `scripts/smoke-real.js` 的未覆盖列表 | **如实记录未覆盖**，不要用 fixture 顶替 |
| 验证工具自己出错 | 怀疑工具：它真的验证了那件事吗？ | 修工具，否则结论不可信 |

最后一条最重要：验证工具出错时会把"没验证到"说成"验证过了"。

## 5. 判断边界

这些**不能**由本流程证明，报告时要明确区分：

- 叙事质量、好笑程度、被尊重感、留存 → 人工评估
- 真实 JEV 会不会选择某分支 → 需要真实凭据且可访问
- CI 是否在远端强制拦截 → 需要仓库设置
- 效率收益 → 需要前后对照测量（模板见 `tooling/templates/efficiency-log-template.md`）

## 6. 常见故障

| 症状 | 处理 |
| --- | --- |
| `ERR_DLOPEN_FAILED` | `npm rebuild better-sqlite3`（Node ABI 与原生模块不匹配） |
| 旅程一直 paused | 看日志的 `flow error`；多半是文本模型或 JEV 不可用 |
| `commit=stale` 日志 | 护栏正常工作，不是故障 |
| 信号不寄出 | 真实 JEV 可能直接行动，这是真实行为不是 bug |
| 场景脚本跑不起来 | 确认用的是 Node ≥ 22 且在仓库根执行 |

更多见 `docs/agent-environment-runbook.md` §7。
