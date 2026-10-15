# 赛博放生

把一只虚拟生物放进文字世界，让它带着你的烦恼自己往下走。它写信，你偶尔回一句。

单生物 · 异步图文旅程。程序掌握权威事实与预算，LLM 负责提遭遇与写表达，
JEV 负责替生物做行动判断。

---

## 快速开始

```bash
npm install
cp server/.env.example server/.env   # 或按 runbook 填好凭据
npm start                             # → http://localhost:3001
```

跑一遍完整检查（不需要任何凭据）：

```bash
npm run check
```

> **Node ≥ 22。** `better-sqlite3` 是原生模块；若报 `ERR_DLOPEN_FAILED`，
> 执行 `npm rebuild better-sqlite3`。详见
> [runbook 的故障定位表](docs/agent-environment-runbook.md#7-故障定位)。

---

## 这个仓库怎么组织的

```
shared/contracts/   公开契约：枚举、错误码、命令校验、DTO（纯模块，前后端共用）
renderer/           前端 H5 + 地球配置的单一数据源
serving/            服务：装配入口、适配器、旅程业务
data/               运行数据与凭据：数据库、.env、日志（不含任何代码）
tests/              单元/契约/场景 + fixture
tooling/            统一检查与边界检查器
scripts/            备份、资源生成、真实冒烟
docs/               设计与验证材料（从 docs/README.md 进）
legacy/             历史原型与旧脚本（禁止被生产路径引用）
```

> `serving/` 是代码，`data/` 是数据。两个名字刻意分开，
> 历史上它们曾叫 `server/` 和同一个 `server/`，很容易看混。

依赖边界是**会失败的检查**，不是文档约定：

- `renderer` 只能通过 HTTP 调 API，不得 import `serving` 或碰数据库
- `shared` 只含纯模块，不得有 IO / env / 密钥
- 原始 SQL 只允许出现在 `serving/adapters/store.js`
- `serving` 不得依赖 `legacy` 或 `tests`
- 脚本与文档不得引用已搬迁的旧路径（断链检查）

```bash
npm run boundaries               # 实际扫描
node tooling/boundary-check.js --self-test   # 证明规则确实会失败
```

---

## 常用命令

| 目的 | 命令 |
| --- | --- |
| 启动 | `npm start` |
| 完整检查 | `npm run check` |
| 快检查 | `npm run check:fast` |
| 只跑测试 | `npm test` |
| 进入某个场景 | `node tests/scenarios/cli.js awaiting_signal` |
| 列出场景 | `node tests/scenarios/cli.js` |
| 真实路径冒烟（花钱） | `node scripts/smoke-real.js` |
| 数据库备份 | `npm run db:backup` |

---

## 给开发 Agent 的入口

**先读 [`AGENTS.md`](AGENTS.md)。** 里面有：

- 改动时必须知道的规则（模型调用、提交护栏、幂等、回复目标、数据迁移、前端状态）
- 每个边界的强制方式
- 验证方法与提交前清单
- 用户既有规则（公众号抓取优先 `opencli weixin download`；想法记录用 thought-vault）

---

## 文档

| 文档 | 内容 |
| --- | --- |
| [docs/README.md](docs/README.md) | **文档索引**：先看这个，区分现行与历史 |
| [AGENTS.md](AGENTS.md) | 下一位 Agent 的入口规则 |
| [设计报告](docs/agent-environment-design.md) | 最终结构、边界规则、契约语义、数据迁移、取舍 |
| [运行手册](docs/agent-environment-runbook.md) | 可执行命令、场景、故障定位 |
| [验证记录](docs/agent-environment-validation.md) | 本轮实际跑出来的结果、未验证项 |
| [改造进度](docs/agent-environment-progress.md) | 阶段完成项、遗留事项 |
| [功能地图](docs/FEATURE-MAP.md) | 怎么到达某个功能、怎么验证 |

---

## 数据与隐私

- 数据库默认在 `data/data.db`，可用 `DB_PATH` / `CYBER_RELEASE_DB` 覆盖。
- 凭据在 `data/.env`，已被 gitignore。
- 用户原话只存在本机数据库，不进日志、不进公共接口（公共脉搏只返回累计数与水域/时间）。
- 配图存在 `renderer/assets/images/`，只在本服务下可达。
