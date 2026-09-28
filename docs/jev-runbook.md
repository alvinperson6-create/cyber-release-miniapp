# JEV 改造 · 运行手册（runbook）

## 1. 环境变量（server/.env，已配置可直接 `npm start`）

### 文本模型（原有，未改）
| 变量 | 当前值 | 说明 |
| --- | --- | --- |
| `AI_PROVIDER` | `qianfan` | 千帆 OpenAI 兼容协议 |
| `AI_API_KEY` | 已配置 | 未配置时全链路自动落本地模板兜底 |
| `AI_MODEL` | `deepseek-v4-flash-0731` | 混合推理模型，故事生成保留深度思考 |
| `IMAGE_*` | 已配置（OpenLux） | 配图；不配置则回信无图（不影响故事链路） |

### JEV 语义链路（本次新增）
| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `JEV_API_KEY` | 无（.env 已配置 typesafe key） | 缺失 ⇒ 语义链路自动关闭，走 legacy 路径 |
| `JEV_ENABLED` | `1` | `0` ⇒ 显式关闭语义链路（记录 legacy 状态） |
| `JEV_BASE_URL` | `https://api.typesafe.ai/v1` | |
| `JEV_MODEL` | `jev-latest` | 实测响应回显 `jev-1.13.0` |
| `JEV_TIMEOUT_MS` | `30000` | 超时 ⇒ 判断降级，链路继续 |
| `JEV_ACCEPT_MIN` / `JEV_FAIL_MIN` | `0.6` / `0.4` | 正向检查通过线/明确失败线（中间 weak 不拦截） |
| `JEV_FAIL_MAX` / `JEV_ALARM_MIN` | `0.4` / `0.6` | 反向检查通过线/明确失败线 |
| `JEV_SITUATION_MIN_CONFIDENCE` | `0.45` | 处境 stance 为 supported 的置信度下限 |
| `STORY_REPAIR_MAX` | `1` | 生成修复预算（结构/语义共享），0=不修复 |

### 旅程实验（第二阶段，默认关闭）
| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `JOURNEY_ENABLED` | `0` | **必须显式 `1` 才启用**（release 创建旅程、路由/调度生效） |
| `JOURNEY_TIME_SCALE` | `1` | 事件节奏缩放；演示可设 `0.0002`（24h 等待 ⇒ ~4.3s/事件）。部署配置，非线上推进 API |

### 数据库
| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `DB_PATH` | `server/data.db` | 测试/评估务必指向独立文件，避免混入真实记录 |

## 2. 启动

```bash
cd server
npm start            # 等价 node --env-file=.env index.js，默认端口 3001
# 首页 http://localhost:3001/  （web-app.html）
```

启动顺序核对（handoff §8）：先 `lsof -nP -i :3001` 确认端口空闲，避免误伤其他进程。

## 3. 降级行为一览（自动，无需人工干预）

| 场景 | 行为 | 落库标记（destinies.semantic_status） |
| --- | --- | --- |
| `AI_API_KEY` 缺失 | 本地模板故事 | `template_fallback` |
| `JEV_ENABLED=0` 或无 `JEV_API_KEY` | 旧生成路径（无契约） | `legacy` |
| JEV 超时/限流/网络错误 | 处境判断降级、语义验收不可用 ⇒ 保留已生成版本 | `judge_unavailable` |
| 结构修复预算耗尽 | 回退本地模板 | `degraded` |
| 语义修复后仍有明确失败 | 保留改善版本 | `degraded`（judge_meta 记录失败维度） |
| 一切通过 / 修复后通过 | — | `accepted` / `repaired` |

判断失败永远不会被记录成通过；`destinies.judge_meta` 保存全部原始证据（检查值、用量、修复记录、notes）。

## 4. 复现命令

```bash
# 离线测试套件（不触网，54 个用例：45 边界 + 4 HTTP 集成 + 9 旅程 + 3 旅程HTTP 中除真实服务的部分）
cd <项目根> && node --test "tests/*.test.js"

# 真实生产路径验证（会计费：2 条故事 + 1 张图，写 docs/jev-eval/real-path/evidence.json）
cd server && node --env-file=.env ../scripts/verify-real-path.js

# 对照评估（会计费；逐样本落盘可断点续跑）
cd server && node --env-file=.env ../scripts/run-comparison-eval.js dev      # 8 条校准（新路径）
cd server && node --env-file=.env ../scripts/run-comparison-eval.js mutate   # 变异反例（仅 JEV 判断）
cd server && node --env-file=.env ../scripts/run-comparison-eval.js eval     # 16 条 × 新旧两臂
cd server && node --env-file=.env ../scripts/run-comparison-eval.js proxy    # 盲评乱序（模型代理）
cd server && node --env-file=.env ../scripts/run-comparison-eval.js summary  # 汇总 summary.json

# 旅程演示（H5，压缩节奏）
JOURNEY_ENABLED=1 JOURNEY_TIME_SCALE=0.001 node --env-file=.env index.js
# 放生时选「自选时间」设为 ~13 分钟后：事件在数秒内铺开、留言窗口充足、
# 最终回信在 +3 分钟（预生成窗口边界）送达
```

## 5. 旅程 API（开关关闭时返回 404）

```bash
GET  /api/journey/:recordId              # 读取即惰性推进（生产时钟）
POST /api/journey/:recordId/message      # { "text": "这次你可以拒绝。" } 一轮一句话
```

留言响应码：409 `journey_ended`（已冻结）/ 409 `already_has_message`（一词千金）/
404 `journey_not_found` / 404+`journeyEnabled:false`（开关未开）。

## 6. 已知运行注意

- 千帆 `deepseek-v4-flash-0731` 混合推理：故事生成保留深度思考（`thinking:true, max_tokens:16000`），
  单条实测 55-60s；这是基线已有的行为，本次未改。
- JEV/千帆 429/529：jev.js 自动退避重试一次；评估脚本额外带重试。
- `data.db` 与 `server.log` 为既有未跟踪文件，本次未做任何清理式操作。
- 基线保护：改造前的 `server/ai.js` 未提交修改快照在 `docs/jev-baseline/`（补丁+文件副本）。
