#!/usr/bin/env node
// 赛博放生 · 固定场景批量验证
//
// 统一 check 的一环：证明每个固定场景都能用一条命令进入并达到预期状态，
// 且默认零真实外部调用。
//
// 输出可直接贴进 docs/agent-environment-validation.md。

const { SCENARIO_NAMES, startScenario } = require('./index');

/** 每个场景必须达到的状态（防止场景"看起来能跑"但其实没到位） */
const EXPECTED = {
  preparing:        { status: 'preparing', phase: 'preparing' },
  awaiting_signal:  { status: 'active', phase: 'awaiting_reply', needsSignal: true },
  settled:          { status: 'active', needsEncounter: true },
  letter:           { status: 'active', needsLetter: true },
  ended_natural:    { status: 'ended_natural', phase: 'ended', needsFinalLetter: true, needsTimeline: true },
  ended_user:       { status: 'ended_user', phase: 'ended', needsTimeline: true },
  paused:           { status: 'paused', phase: 'paused', pauseReason: 'task_retry_exhausted' }
};

async function main() {
  console.log(`验证 ${SCENARIO_NAMES.length} 个固定场景（零真实外部调用）\n`);

  const rows = [];
  let failed = 0;

  for (const name of SCENARIO_NAMES) {
    const s = await startScenario(name);
    let summary;
    try {
      summary = s.summary();
      const exp = EXPECTED[name] || {};

      const problems = [];
      if (exp.status && summary.status !== exp.status) problems.push(`status=${summary.status} 期望 ${exp.status}`);
      if (exp.phase && summary.phase !== exp.phase) problems.push(`phase=${summary.phase} 期望 ${exp.phase}`);
      if (exp.needsSignal && !summary.pendingSignal) problems.push('缺少 pendingSignal');
      if (exp.needsLetter && !summary.messages.some(m => m.kind === 'letter')) problems.push('缺少阶段来信');
      if (exp.needsFinalLetter && !summary.messages.some(m => m.kind === 'final_letter')) problems.push('缺少收束来信');
      if (exp.needsTimeline && !summary.timelineNodes) problems.push('时间线未开放');
      if (exp.pauseReason) {
        const w = s.world;
        const j = w.store.getJourney(summary.journeyId);
        if (j.pause_reason !== exp.pauseReason) problems.push(`pause_reason=${j.pause_reason} 期望 ${exp.pauseReason}`);
      }
      if (exp.needsEncounter) {
        const w = s.world;
        if (!w.store.getEncounters(summary.journeyId).length) problems.push('没有遭遇记录');
      }
      // 硬性：场景绝不允许真实外部调用
      if (summary.externalCalls !== 0) problems.push(`externalCalls=${summary.externalCalls} 必须为 0`);

      if (problems.length) {
        failed++;
        console.log(`  ✖ ${name.padEnd(14)} ${problems.join('；')}`);
      } else {
        console.log(`  ✔ ${name.padEnd(14)} ${summary.status}/${summary.phase}` +
          ` msgs=[${summary.messages.map(m => m.kind).join(',') || '-'}] calls=${summary.modelCalls}`);
      }
      rows.push({ name, ok: problems.length === 0, summary });
    } finally {
      await s.reset();
    }
  }

  console.log('');
  if (failed) {
    console.error(`${failed}/${SCENARIO_NAMES.length} 个场景未达预期状态`);
    process.exitCode = 1;
    return;
  }
  console.log(`全部 ${SCENARIO_NAMES.length} 个场景达到预期状态。`);
  console.log('进入某个场景：node tests/scenarios/cli.js <场景名>');
}

main().catch(err => { console.error(err); process.exitCode = 1; });
