# 赛博放生 · 文档索引

按"现在该看哪一份"分层。**判断标准是时效性，不是主题**——
一份 2026-09 的文档即使主题仍在，也不是当前行为的依据。

---

## 现在该看这些

| 文档 | 什么时候看 |
| --- | --- |
| [../README.md](../README.md) | 第一次接触这个项目 |
| [../AGENTS.md](../AGENTS.md) | 改代码之前（必读） |
| [agent-environment-design.md](agent-environment-design.md) | 想知道结构为什么这么设计、边界怎么强制 |
| [agent-environment-runbook.md](agent-environment-runbook.md) | 要执行命令、排查故障 |
| [agent-environment-validation.md](agent-environment-validation.md) | 要看验证结果与未覆盖项 |
| [agent-environment-progress.md](agent-environment-progress.md) | 想知道这轮改了什么、还有什么没做 |
| [FEATURE-MAP.md](FEATURE-MAP.md) | 找不到某个功能的代码位置 |
| [HANDOFF-Agent工程环境改造.md](HANDOFF-Agent工程环境改造.md) | 上一轮的交接原件（已执行完，保留作对照） |

> 上面的四份 `agent-environment-*` 是**当前唯一**的现行设计/验证材料。
> 其余带 `jev-` / `journey-v2-` 前缀的都是更早阶段的历史记录。

---

## 历史记录（了解演进用，**不是当前行为依据**）

### JEV 语义判断改造（2026-09-27 完成）

| 文档 | 内容 |
| --- | --- |
| [jev-design.md](jev-design.md) | 该轮的设计：语义判断如何嵌入流程 |
| [jev-validation.md](jev-validation.md) | 该轮的验证记录。**含仍在生效的校准依据**，例如 `guards.js` 里引用的置信度阈值就出自这里 |
| [jev-runbook.md](jev-runbook.md) | 该轮的运行手册（当时的目录结构已变，仅供对照） |
| [jev-progress.md](jev-progress.md) | 该轮的进度 |

配套材料：

- [product-history/2026-09-27-jev-handoff.md](product-history/2026-09-27-jev-handoff.md) — 该轮交接
- [jev-baseline/](jev-baseline/) — 改造前的代码快照
- [jev-eval/](jev-eval/) — 盲评与真实路径验证产物。**数据库已导出为 JSON 快照**（原 `.db` 含 `-wal`/`-shm`，不适合进版本库）

### journey-v2 旅程形态（2026-10 上旬完成）

| 文档 | 内容 |
| --- | --- |
| [journey-v2-design.md](journey-v2-design.md) | 遭遇/来信/信号的数据形态设计 |
| [journey-v2-validation.md](journey-v2-validation.md) | 该轮验证记录 |
| [journey-v2-runbook.md](journey-v2-runbook.md) | 该轮运行手册 |
| [journey-v2-progress.md](journey-v2-progress.md) | 该轮进度 |

配套：[journey-v2-eval/](journey-v2-eval/)、[baseline-v2/](baseline-v2/)

### 更早

- [handoff.md](product-history/2026-09-29-第一阶段-handoff.md) — 第一阶段（四集时代）的交接，已完成

---

## 一个提醒

**这些历史文档里的路径、命令、目录结构大多已经过时。**

比如 `jev-runbook.md` 里可能写着 `server/index.js`、`npm run dev:all` 之类——
那些入口在工程环境改造后已经变了。用它们对照历史结论可以，
照着敲命令不行。当前命令一律以 [agent-environment-runbook.md](agent-environment-runbook.md)
和 `npm run check` 的实际输出为准。

代码注释里引用历史文档（如 `serving/adapters/guards.js` 引用
`jev-validation.md` 的阈值）是有意的：那条校准依据至今有效，
但**执行方式**以现行文档为准。