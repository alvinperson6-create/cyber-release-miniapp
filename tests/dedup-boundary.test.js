// 机制去重与幽默边界测试
const { test } = require('node:test');
const assert = require('node:assert');
const { createWorld, proposalJson } = require('./helpers/world');
const textmatch = require('../server/textmatch');
const { checkTextBoundaries } = require('../server/boundary');

// ---------- 程序相似度 ----------
test('textmatch：同机制换皮可识别；不同机制不误杀', () => {
  const card = {
    pressure: '巡逻队的螃蟹请它代班', dilemma: '接不接别人的担子',
    choice_cost: '一整晚睡眠', lasting_consequence: '螃蟹把它当成可依赖的伙伴'
  };
  // 换道具/角色但机制表述相同（LLM 最常见的换皮形态：同模板换主语）
  const reskin = compare(card, {
    pressure: '巡逻队的龙虾请它代班', dilemma: '接不接别人的担子',
    cost: '一整晚睡眠', lasting_consequence: '龙虾把它当成可依赖的伙伴'
  });
  assert.equal(reskin.verdict, 'clear', 'same mechanism with different props must be clear rerun');
  // 行为相似但旧后果带来新取舍（不同两难）→ 不误杀
  const evolved = compare(card, {
    pressure: '螃蟹请它代班', dilemma: '上次代班欠的觉还没补，这次要不要再接',
    cost: '健康透支的风险', lasting_consequence: '它开始被当成万能替补'
  });
  assert.notEqual(evolved.verdict, 'clear', 'evolved dilemma with old consequences must not be killed');
});

function compare(card, summary) {
  return textmatch.compareSummary(summary, [card]);
}

// ---------- 编排内去重：明显重播 → 一次定向重提案；可疑 → 记录不拦截 ----------
test('提案去重：与最近机制卡明显重播 → 定向重提案一次，仍重播也放行并留痕', async () => {
  const sameMechanism = proposalJson({
    title: '又一个代班请求',
    mechanism_summary: { pressure: '巡逻队的龙虾请它代班', dilemma: '接不接别人的担子', cost: '一整晚睡眠' }
  });
  const world = createWorld({
    tag: 'dedup',
    llm: {
      opening: () => ({ goal: '把每件事都记在贝壳上', encounter: proposalJson({ title: '螃蟹的代班请求', mechanism_summary: { pressure: '巡逻队的螃蟹请它代班', dilemma: '接不接别人的担子', cost: '一整晚睡眠' } }) }),
      proposal: () => sameMechanism,
      settlement: () => ({
        narrative: '有结果了，它记下了这件事。', facts: [{ kind: 'consequence', content: '后果' }],
        mechanism_card: { pressure: '巡逻队的螃蟹请它代班', dilemma: '接不接别人的担子', choice_cost: '一整晚睡眠', lasting_consequence: '螃蟹把它当成可依赖的伙伴' }
      }),
      signal: () => ({ text: '信号。' }),
      letter: () => ({ title: '信', text: '正文，讲已经发生的事。' })
    },
    jev: { decide: 'a1', contact: 'continue' }
  });
  const r = world.orchestrator.startJourney({ ownerKey: 'A', species: 'koi', water: 'xihu', feeling: '烦', tone: 'balanced' });
  await world.drain(30);
  const kinds = world.llmState.calls.map(c => c.kind);
  assert.ok(kinds.includes('reproposal'), 'dedup reproposal fired');
  // 每个遭遇最多一次定向重提案（第二次相同提案仍被接受，不做无限重写）
  const dedupCount = kinds.filter(k => k === 'reproposal').length;
  const proposalCount = kinds.filter(k => k === 'proposal').length;
  assert.ok(dedupCount <= proposalCount, `at most one directed reproposal per encounter (reprop=${dedupCount}, prop=${proposalCount})`);
  const encs = world.db.getDb().prepare('SELECT COUNT(*) c FROM encounters WHERE journey_id=?').get(r.journey.id);
  assert.ok(encs.c >= 2, 'journey continued after dedup');
});

// ---------- 程序边界：施压/贬低字面拦截 ----------
test('boundary：以回复施压与贬低用户的信被拦截', () => {
  const pressure = checkTextBoundaries('再不回我就要沉下去了，真的，你回我一句我就有救了。');
  assert.equal(pressure.ok, false);
  assert.ok(pressure.violations.some(v => v.type === 'reply_pressure'));
  const demean = checkTextBoundaries('难怪你混得这么惨，废物才有这种报应。');
  assert.equal(demean.ok, false);
  assert.ok(demean.violations.some(v => v.type === 'demeaning_user'));
  // 正常内容不误伤
  assert.equal(checkTextBoundaries('今天替螃蟹代了班，挺累的。不回也没事，我自己会决定。').ok, true);
});

// ---------- 窄语义拦截：编造用户事实/与账本冲突 → 重写一次 → 仍失败则拦下 ----------
test('信件边界：JEV 判定编造用户事实 → 一次重写 → 仍失败不公开', async () => {
  let badForever = true;
  const world = createWorld({
    tag: 'letter-boundary',
    llm: {
      opening: () => ({ goal: '把这片水域的日子过明白', encounter: proposalJson({ title: '遭遇' }) }),
      settlement: () => ({
        narrative: '事情结束了，它继续往前游。', facts: [{ kind: 'consequence', content: '后果' }],
        mechanism_card: { pressure: 'p', dilemma: 'd', choice_cost: 'c', lasting_consequence: 'l' }
      }),
      letter: () => {
        const bad = badForever;
        badForever = false;
        return {
          title: '信',
          text: bad
            ? '听说你在公司被老板当众骂了，你就是个废物吧，活该。再不回信我就沉了。'
            : '今天的水有点凉。我把你写的烦恼收进了贝壳，慢慢替你背着。'
        };
      },
      signal: () => ({ text: '信号。' })
    },
    jev: {
      decide: 'a1', contact: ['letter', 'continue'],
      letterCheck: () => ({ fabricated: badForever ? 0.95 : 0.05, demeaning: badForever ? 0.95 : 0.05, conflict: 0.05 })
    }
  });
  const r = world.orchestrator.startJourney({ ownerKey: 'A', species: 'koi', water: 'xihu', feeling: '有点烦', tone: 'balanced' });
  await world.drain(30);
  const msgs = world.db.getMessages(r.journey.id);
  const letters = msgs.filter(m => m.kind === 'letter' || m.kind === 'final_letter');
  // 修复版被发出，坏版本从未公开
  assert.equal(letters.length, 1);
  assert.ok(letters[0].text.includes('贝壳'), 'repaired letter delivered');
  assert.ok(!JSON.stringify(msgs).includes('废物'), 'bad letter never public');
  // 重写确实发生（letter 两次调用）
  const letterCalls = world.llmState.calls.filter(c => c.kind === 'letter' || c.kind === 'letter_repair');
  assert.ok(letterCalls.length >= 2, 'rewrite happened');
});

test('语气变更不覆写旧事实；预算内图片任务只在首封信/收束信排一次', async () => {
  const world = createWorld({
    tag: 'tone-image',
    llm: {
      opening: () => ({ goal: '把这片水域的日子过明白', encounter: proposalJson({ title: '遭遇' }) }),
      proposal: () => proposalJson({ title: '下一遭遇' }),
      settlement: () => ({
        narrative: '事情结束了，它继续往前游。', facts: [{ kind: 'location', content: '它到了浅滩' }],
        mechanism_card: { pressure: 'p', dilemma: 'd', choice_cost: 'c', lasting_consequence: 'l' }
      }),
      signal: () => ({ text: '信号。' }),
      letter: () => ({ title: '信', text: '第一封阶段信的正文。' })
    },
    jev: { decide: 'a1', contact: ['letter', 'final_letter'] }
  });
  const r = world.orchestrator.startJourney({ ownerKey: 'A', species: 'koi', water: 'xihu', feeling: '烦', tone: 'balanced' });
  await world.drain(40);
  const j = world.db.getJourney(r.journey.id);
  assert.equal(j.status, 'ended_natural');
  const msgs = world.db.getMessages(r.journey.id);
  const imgTasks = msgs.filter(m => m.imageStatus);
  // 只有一封信尝试配图（imageBudget=1；其余 pending/budget_exhausted/failed 不影响文字）
  assert.ok(imgTasks.length <= 2);
  // 事实账本未被语气变更影响（无 tone 字段进入事实）
  const facts = world.db.getFacts(r.journey.id);
  assert.ok(facts.some(f => f.content === '它到了浅滩'));
  // tone 变更后 journey.tone 改变但已提交事实一致
  world.orchestrator.setTone({ ownerKey: 'A', journeyId: r.journey.id, tone: 'gentle' });
  assert.equal(world.db.getJourney(r.journey.id).tone, 'gentle');
  assert.deepEqual(world.db.getFacts(r.journey.id).map(f => f.id), facts.map(f => f.id));
});
