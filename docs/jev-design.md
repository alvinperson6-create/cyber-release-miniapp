# 赛博放生 × JEV 改造 · 最终方案（design）

日期：2026-09-27　分支：`jev-modify`　执行：无人值守（用户睡眠期间，按 handoff.md 默认范围）

## 0. 一句话总览

在不动现有「放生 → 四集命运轨迹 → 回信 + 配图 + 解锁」体验的前提下，为故事生成加了一条
**可开关的语义链路**：JEV 识别原话里的**具体处境** → 程序编译**创作契约** → 文本模型按契约写故事
→ 程序查**结构**、JEV 查**因果** → 至多一次定向修复 → 明确接受/降级并落库冻结。
第二阶段在 `JOURNEY_ENABLED`（默认关）后面做了一个**生物事件 + 一句话留言**的最小实验。

## 1. 职责分工（谁拥有什么）

| 组件 | 拥有的职责 | 不做的事 |
| --- | --- | --- |
| JEV（typesafe `jev-latest`，实测返回 `jev-1.13.0`） | 有限选项判断（处境四值 stance、证据句段选择）、是非命题判断（8 项因果验收 + 账本一致性）、留言意图二选一 | 自由生成文本；判断故事之外的任何东西 |
| 文本模型（千帆 `deepseek-v4-flash-0731`，沿用现有配置） | 写故事、定向修复、代理盲评 | 修改权威状态、充当审核终审 |
| 程序 | 分句编号、契约编译、结构校验、阈值决策、修复预算、状态迁移/冻结/幂等、事件后果表、留言效果、时钟 | 把语义判断交给规则、把规则能做的事交给模型 |

## 2. 第一阶段：具体烦恼识别 + 故事因果验收

### 2.1 模块与数据流

```
原始输入（原话，权威）
  → situations.recognizeSituations        JEV Choice×16（8 处境 × stance/evidence），一次请求，问题独立
      · 程序分句 s1..s8，证据只允许选句段 ID，程序恢复原文 —— 不让 JEV 自由生成引用
      · stance ∈ supported/contradicted/unexpressed/ambiguous；低置信度不采信（situationMinConfidence）
      · 判断失败/超时/无凭证 → degraded + degradeReason，链路继续（不把未知当否）
  → contract.buildCreationContract        纯函数，确定性编译（同输入必同输出）
      · 内容：原话+句段表、被支持处境+证据、行为倾向要求（8 条确定性映射）、反驳/含糊清单、
        事实边界（不得虚构用户事实）、四集结构要求、契约版本 situation-contract-v1、判断来源/降级状态
  → ai.buildDestinyPrompt(contractText)   契约注入生成提示词（无契约时与旧 prompt 完全一致）
  → ai.parseDestinySegmentsStrict         严格解析（旧 parseDestinySegments 保留模板兜底语义）
  → acceptance.checkStructure             程序：四集/字数/空内容/地点/画面描述字段
  → acceptance.checkSemantics             JEV Noul×8，一次请求：
        正向(高好)：行为改变、因果1→2、因果2→3、因果3→4、结局铺垫
        反向(低好)：虚构用户事实、调侃越界、图文冲突（旅程时另有账本一致性）
  → 确定性决策（decideCheck）             正向：≥acceptMin 过 / ≤failMin 败 / 中间 weak（记录不拦截）
                                          反向镜像；无模型裁量
  → 至多 STORY_REPAIR_MAX 次定向修复      结构/语义共享预算；修复 prompt 只带失败维度+相关材料+上一版 JSON
      · 修复后全量复查语义（JEV 便宜，宁全勿漏）
  → 终态（meta.status，落库 semantic_status）：
        accepted（一次通过）/ repaired（修复后通过）/ degraded（修不好，保留改善版并如实标记失败维度）
        judge_unavailable（语义判断不可用，保留版本绝不记成通过）
        legacy（JEV 链路关）/ template_fallback（无 AI 或彻底失败，本地模板）
```

### 2.2 统一编排与幂等

- `story-pipeline.createStoryForRecord` 是唯一编排核心；`reply-generator.ensureStoryAndReply`
  是唯一入口封装，**调度器（index.js 每 10s）与 HTTP `/api/reply/generate` 都走它**。
- 进程内 `inflight` Map 去重同记录并发；`db.insertDestinyOnce`（ON CONFLICT DO NOTHING）race-safe；
  写入即 `frozen_at` 冻结，重复生成不覆盖已公开故事。
- 修复了旧 `insertDestiny` UPSERT 会重置 `unlocked_indices` 的缺陷（冲突时不再触碰解锁状态）。
- 回信 = segments[3].text、配图 = 同一版本的 visualForImage —— 单一事实来源；
  图片生成在故事冻结之后，旧图不可能配上新结局。

### 2.3 阈值（小样本校准，非真理）

`acceptMin=0.6 / failMin=0.4 / failMax=0.4 / alarmMin=0.6 / situationMinConfidence=0.45`，
全部可由环境变量覆盖；校准方法与结果见 `docs/jev-validation.md`。中间带 weak 不拦截，
是针对官方文档「CJK 准确率低于英文」的保守设计：只拦明确失败，不误伤合理荒诞。

## 3. 第二阶段：生物事件 + 一句话留言（`JOURNEY_ENABLED`，默认关）

- 一个演示场景：锦鲤/乌龟 × 一句「来者不拒」型烦恼 × 三个事件（螃蟹代班 → 水草搬家 → 湖长联欢会）
  × 合法动作 {答应, 拒绝, 协商, 求助, 离开} × 一轮可选留言 × 一封最终回信。
- 时间轴：三个事件在「回信时间 − 预生成窗口(10min)」内等距铺开；`JOURNEY_TIME_SCALE`
  供演示压缩节奏（部署配置，不是线上任意推进 API）；推进入口=惰性读取+调度器，同一生产函数
  `advanceJourney(recordId, { now })`，`now` 可注入即测试用可控时钟。
- 动作判定：JEV Choice（合法集合内）优先，不可用时按行为倾向的确定性规则回退，来源落账本。
- 后果表 `OUTCOMES` 由代码拥有；状态迁移确定性；事件结果落账本后重放零模型调用。
- 留言：一词千金（每轮一条）；先判意图（JEV / 关键词回退），`permission_to_refuse` 才把行为倾向
  改为 assertive，**只影响之后的事件**；旅程冻结后留言被拒（409 journey_ended）。
- 冻结：destiny 存在（回信已写）→ 旅程 `letter_frozen`；已展示事件与结局不可改写。
- 回信：`buildJourneyContext` 把账本摘要注入创作契约，验收增加 `ledger_consistency` 反向检查。

## 4. 模型与外部边界（实测）

- JEV：`POST https://api.typesafe.ai/v1/systemone`，Bearer 鉴权；`model=jev-latest`（响应回显 `jev-1.13.0`）；
  Noul 无独立 confidence；同请求问题彼此独立（官方文档，已按此设计）。
- JEV 输入仅文本 → 验收对象是文本（剧集/地点/画面描述）之间的一致性，**不宣称能验收最终图片**；
  图片质量属人工/图像工具评估范围，本次未做。
- 中文效果：官方声明 CJK 准确率低于英文 → 本项目全部题目为中文、阈值留中间带、
  真实样本上的误报/漏报见 validation 文档，不做外推。
- 成本：JEV 单次判断实测 ~300-700 tokens、0.5-1.5s；未取得计价单据，validation 中只报 token 与时延。

## 5. 关键取舍

1. **weak 中间带**：宁可漏拦（有记录）不可误杀（合理荒诞被误判是现有产品语言的一部分）。
2. **修复预算=1 次定向**：handoff 明令禁止“直到满意”；结构/语义共享预算，便于统计修复率。
3. **降级也交付**：degraded 故事仍上线但 `semantic_status` 如实为 degraded —— 与其回退模板失去
   语境，不如带上「未通过维度」元数据给后续产品决策用；绝不冒充通过。
4. **处境证据用句段 ID**：程序恢复原文，避免模型自由引用造成不可验证的“证据”。
5. **事件动作来源落库**：jev / rule_fallback 可区分，实验不把规则回退说成模型效果。
6. **不引入新框架/多 Agent**：全部为现有 Node/Express/SQLite 上的增量模块。

## 6. 文件清单（本改造新增/修改）

```
新增  server/flags.js            功能开关与阈值
新增  server/jev.js              JEV 适配器（错误分类/超时/退避/答案校验）
新增  server/situations.js       处境识别（分句、双问、证据恢复、降级）
新增  server/contract.js         创作契约（确定性编译）
新增  server/acceptance.js       结构校验 + 语义验收 + 确定性决策
新增  server/story-pipeline.js   统一编排核心（生成预算/修复/终态）
新增  server/journey.js          旅程引擎（事件/后果/留言/冻结）
新增  server/routes/journey.js   旅程路由（惰性推进/留言）
修改  server/ai.js               chatCompletion 返回元数据+用量台账；契约注入；定向修复 prompt；
                             严格解析器；原有的千帆 thinking 修复与图片格式检测保留为基线
修改  server/db.js               DB_PATH 可配置；destinies 新列（semantic_status/judge_meta/
                             contract_meta/frozen_at）；insertDestinyOnce/freezeDestiny；
                             修复解锁重置缺陷；journeys 表
修改  server/reply-generator.js  统一入口 ensureStoryAndReply（幂等/并发去重/冻结/补图不重写）
修改  server/routes/reply.js     /generate 复用统一核心（旧的手写编排删除）
修改  server/routes/release.js   旅程开关开启时创建旅程（响应带 journey 字段）
修改  server/index.js            journey 路由挂载；调度器推进旅程；health 增加 journeyEnabled
修改  web-app.html               回执内嵌「旅途实况」面板（事件流/留言/定格提示）
新增  tests/*.test.js            离线边界 + HTTP 集成测试（node --test）
新增  scripts/verify-real-path.js            真实生产路径验证入口
新增  scripts/run-comparison-eval.js         对照评估入口（dev/eval/mutate/proxy/summary）
新增  docs/jev-eval/             样本、评估产物、真实路径证据
```

## 7. 明确不做（本次边界）

故事去重、幽默偏好、生物相遇、群体世界事件、故事档案、分享卡（handoff §6 路线图）；
图像验收；真实广告接入；公共分享匿名化；小程序新玩法（旧路径保持兼容，未触碰）。
