# 赛博放生 · 项目长期约定

## 环境

- **Node 20–26**（`better-sqlite3` 12.x 的支持范围）。
  它是原生模块，编译时的 Node ABI 必须与运行时的 Node 一致，否则
  `ERR_DLOPEN_FAILED`（错误信息指向模块内部，看不出是版本问题）。
  **本机同时装有托管 Node 22（npm 默认走它）与系统 Node 25，
  原生模块按 Node 25 编译**——所以裸 `node xxx.js` 可能失败。
  npm scripts 都经 `scripts/with-node.sh` 启动，它会**实际建库测试**后
  自动挑选可用 Node 并说明是否切换过；因此 `npm start` / `npm run check`
  在任何 Node 环境下都能直接用。手动指定：`scripts/with-node.sh <命令>`。
- `npm run check` 会主动断言 ABI 并给出修复命令（`npm rebuild better-sqlite3`）。
- 凭据在 `data/.env`（gitignored），模板见 `data/.env.example`。
- 数据库默认 `data/data.db`（旧库 `server/data.db` 仍兼容读取）；备份用
  `node scripts/db-backup.js`（走 SQLite backup API）。
- **JEV 需要显式代理**：`data/.env` 里设 `JEV_PROXY=http://127.0.0.1:7897`。
  JEV 按出口 IP 做地域限制，中国大陆直连返回 451；Node 的 fetch 不读系统代理
  （含内置 `--use-env-proxy` 也无效），必须用 `serving/adapters/http-client.js` 的
  undici ProxyAgent。本机代理端口查 `scutil --proxy | grep -A2 HTTPSEnable`。

## 目录与边界

`shared/contracts`（纯契约）/ `renderer`（前端 + 地球配置数据源）/ `serving`（服务代码）
/ `data`（数据库、.env、日志，**不含代码**）/ `tests` / `tooling` / `scripts` / `legacy`。

- `serving` 与 `data` 刻意不同名：历史上它们都叫 `server/`，极易看混。
- 边界是**会失败的检查**（`npm run boundaries`），不是文档约定。改动不要放宽规则。
- 文档从 `docs/README.md` 进，按时效性分现行/历史两层。

## 命令

```bash
npm start              # 启动（唯一实际启动入口是 serving/entrypoints/start.js）
npm run check          # 统一检查 5 项
npm test               # 只跑测试
npm run scenario <名>  # 进入固定场景
npm run smoke:real     # 真实冒烟（花钱，需 JEV_PROXY）
```

## GitHub

- 远端：`github.com/alvinperson6-create/cyber-release-miniapp`
- 主开发分支：`jev-modify`（**不是 main**）
- **push 必须走代理**：国内直连会 Empty reply from server
  `git -c http.proxy=http://127.0.0.1:7897 -c https.proxy=http://127.0.0.1:7897 push origin jev-modify`
- **不能提交 `.github/workflows/`**：当前 OAuth 授权缺 workflow scope，
  含该目录的提交一律被远端拒绝。已加入 .gitignore。
  需要 CI 时先授权（PAT 勾选 workflow）再移除该行。
  若历史已提交过，需 `filter-branch` 剥离后再推。

## 验证纪律

- 固定场景证明"受控输入下程序正确"，**不能**证明真实 JEV 会选那个分支。
- 收紧边界时必须同时断言"该可达的仍可达"，否则会把功能改坏而检查全绿。
- 验证工具自己出错比没有验证更危险；报"通过"前先确认它真的验证了那件事。
- JEV 不可用时系统会重试后如实暂停，不用规则冒充——这是正确行为，不是故障。

## 用户既有规则（不要覆盖）

- 公众号内容抓取优先 `opencli weixin download`
- 想法记录用 thought-vault

## 历史

- 2026-10-15 完成 Agent 工程环境改造（阶段 A–F），commit `40967f7`
- 详见 `docs/agent-environment-{design,runbook,validation,progress}.md`
