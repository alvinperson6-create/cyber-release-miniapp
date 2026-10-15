# 功能模板（最小示例）

新功能按这个骨架落地。**只生成有意义的契约、Client/Host 入口、边界与必要检查**——
不要为了"符合模板"生成空壳文件。末尾的示例是一个已完成的最小功能，可直接对照。

---

## 1. 先回答五个问题

写代码之前：

1. **它属于哪一层？** command（写）/ query（读）/ workflow（编排）/ commit（原子落账）/ context（提示词）/ policy（纯策略）/ adapter（外部 IO）
2. **它的公开契约是什么？** 需要新增错误码吗？需要新增 DTO 字段吗？
3. **它怎么提交？** 走 `commits/` 吗？提交前要复核什么（状态？快照？租约？）
4. **它怎么被验证？** 哪个场景？哪条不变量？
5. **它会引入什么边界违规风险？** SQL？跨层 import？

五个问题答不上来就先别写。

---

## 2. 骨架

### 2.1 契约（`shared/contracts/`）

只在**浏览器也需要知道**时才加。纯服务端内部的东西不要进 shared。

```js
// errors.js：新增错误码，状态码在此固定
my_error: { http: 400, message: '面向用户的说明' },

// enums.js：如果引入新状态机，显式命名
const MY_STATUS = { PENDING: 'pending', DONE: 'done' },

// commands.js：输入校验（纯函数，返回 {ok, code}）
function parseMyCommand(input) { /* ... */ }
```

### 2.2 命令（`serving/features/journey/commands/`）

```js
function createMyCommand({ store, clock }) {
  function execute({ ownerKey, journeyId, input }) {
    // 1. 契约校验
    const parsed = parseMyCommand(input);
    if (!parsed.ok) return { ok: false, code: parsed.code };

    // 2. 归属校验（跨 owner 一律 404）
    const journey = store.getOwnedJourney(journeyId, ownerKey);
    if (!journey) return { ok: false, code: 'journey_not_found' };

    // 3. 幂等：事务外先查（只为快速返回）
    const fingerprint = fingerprintOf('myOp', parsed.value);
    if (parsed.value.requestId) {
      const prior = store.readCommandResult({ ownerKey, operation: 'myOp',
        requestId: parsed.value.requestId, fingerprint });
      if (prior.conflict) return { ok: false, code: 'idempotency_conflict' };
      if (prior.hit) return { ...prior.result, replayed: true };
    }

    // 4. 事务：业务变化 + 幂等结果一起落
    const tx = store.getDb().transaction(() => {
      const inTx = store.readCommandResultIn(store.getDb(), { ownerKey, operation: 'myOp',
        requestId: parsed.value.requestId, fingerprint });
      if (inTx.conflict) throw new Conflict();
      if (inTx.replay) return { replay: true, result: inTx.result };

      // —— 业务写入：只能调用 store 的函数，不写 SQL ——
      // store.xxx(...);

      const result = { ok: true /* … */ };
      store.recordCommandResult(store.getDb(), { ownerKey, operation: 'myOp',
        requestId: parsed.value.requestId, fingerprint, result, now });
      return { replay: false, result };
    });
    // 5. 调度结果区分语义
    // return { ok: true };
  }
  return { execute };
}
```

### 2.3 查询（`queries/`）

只获得读取能力。不调模型、不写状态、不拿原始写句柄。

```js
function getMyThing({ ownerKey, journeyId }) {
  const journey = store.getOwnedJourney(journeyId, ownerKey);
  if (!journey) return null;
  // 只调 store 的读取函数
  return { /* DTO */ };
}
```

### 2.4 提交（`commits/`）

模型 await 之后、提交之前**必须**复核：

```js
function commitMyThing({ store, journeyId, payload, now, schedule }) {
  // 1. 复核旅程状态（终态 → cancelled）
  const fresh = store.readJourneyForCommit(journeyId);
  if (!fresh) return { result: COMMIT_RESULT.STALE, reason: 'journey_missing' };
  if (['ended_user', 'ended_natural', 'aborted'].includes(fresh.status)) {
    return { result: COMMIT_RESULT.CANCELLED, reason: `journey_${fresh.status}` };
  }

  // 2. 复核输入快照（条件更新，不匹配 → stale）
  try {
    const tx = store.getDb().transaction(() => {
      const ok = store.someConditionalUpdate(...);   // 期望不匹配时返回 false
      if (!ok) throw new CommitAbort(COMMIT_RESULT.STALE, 'snapshot_superseded');
      if (schedule) schedule(now);                  // 排程与事实同事务
    });
    tx();
    return { result: COMMIT_RESULT.APPLIED };
  } catch (err) {
    if (err instanceof CommitAbort) return { result: err.result, reason: err.reason };
    throw err;
  }
}
```

### 2.5 路由（`entrypoints/api-router.js`）

薄壳：解析输入、调用 command/query、映射状态码。**不含业务逻辑。**

```js
router.post('/journey/:id/my-thing', (req, res) => {
  try {
    const r = commands.myThing.execute({
      ownerKey: req.ownerKey, journeyId: req.params.id, input: withRequestId(req)
    });
    if (!r.ok) return res.status(httpStatusFor(r.code)).json(toErrorDto(r.code));
    return res.json({ ok: true, /* … */, replayed: !!r.replayed });
  } catch (err) {
    console.error('[my-thing]', err.message);
    return res.status(500).json(toErrorDto('internal_error'));
  }
});
```

### 2.6 客户端（`renderer/index.html`）

- 服务端副本进 `state.serverViews[journeyId]`
- 临时状态进 `state.ui`
- 草稿按业务 ID 进 `state.drafts`（不要按旅程）
- 写命令必须带 `idempotencyKey: newIdempotencyKey('myThing')`
- 响应过 `validateView()` + `isFresh()` 闸门
- 模型文本经 `esc()`

### 2.7 检查

```bash
# 1. 契约
#    在 tooling/contracts-check.js 加非法输入断言
# 2. 业务
#    在 tests/ 里加测试；竞态加进 tests/race-and-guards.test.js
# 3. 场景（如果它是一种可复现状态）
#    在 tests/scenarios/index.js 的 SCENARIOS 里加一项，并在 verify-all.js 的
#    EXPECTED 里写明必须达到什么
# 4. 前端（如果有 UI）
#    在 tests/frontend-contract.test.js 加静态断言
# 5. 边界
npm run check
```

### 2.8 文档

- `docs/FEATURE-MAP.md`：加一行（怎么到达、locator、命令、Host 变化、验证位置）
- `docs/agent-environment-validation.md`：加实际跑出来的结果
- 若引入新边界规则：`tooling/boundary-check.js` + 对应违规样例 + 自测断言

---

## 3. 已完成的最小示例：结束旅程

这是一个**真实存在**的完整功能，可直接对照。

**契约**（`shared/contracts/commands.js`）

```js
function parseEndCommand(input = {}) {
  const rid = normalizeRequestId(input.requestId);
  if (!rid.ok) return rid;
  return { ok: true, value: { requestId: rid.requestId } };
}
```

**错误码**（`shared/contracts/errors.js`）

```js
already_ended: { http: 409, message: '本程已经结束' },
```

**命令**（`commands/end.js`）核心：条件更新保证只成功一次，幂等结果同事务。

```js
const applied = store.endJourneyByUser(journeyId, now);
if (!applied) throw new AlreadyEnded();
store.cancelTasksForJourney(journeyId, now);
store.insertMessage({ /* 服务提示 */ });
const result = { ok: true, status: 'ended_user' };
store.recordCommandResult(db, { /* … */ result, now });
```

**验证**（`tests/race-and-guards.test.js`）

```js
test('结束幂等：重试只产生一条结束提示', async () => {
  const input = { requestId: 'req-end-000001' };
  const first = w.commands.endJourney.execute({ ownerKey: 'A', journeyId, input });
  const second = w.commands.endJourney.execute({ ownerKey: 'A', journeyId, input });
  assert.equal(second.replayed, true);
  const sysMsgs = w.store.getMessages(journeyId).filter(m => m.kind === 'system');
  assert.equal(sysMsgs.length, 1);
});
```

**场景**（`tests/scenarios/index.js` 的 `ended_user`）

```js
async build(w) {
  const r = w.commands.release.execute({ /* … */ });
  await w.drain(3);
  w.commands.endJourney.execute({ ownerKey: 'A', journeyId: r.journeyId, input: {} });
  return { journeyId: r.journeyId };
}
```

**为什么它算最小示例**：一个命令、一个错误码、一条测试、一个场景，
覆盖了幂等、归属、条件更新、路由映射——没有多余文件。
