#!/usr/bin/env node
// 赛博放生 · 地球配置同步
//
// 来源：renderer/globe-config.source.js（网页端与 3D 地球的单一数据源）
// 目标：renderer/assets/globe-config.json（H5 加载的产物）
//
// 历史：这份数据最初来自 miniprogram/utils/globe-config.js（小程序端），
// 小程序端归档后已迁到 renderer/ 下，与消费方同层。
//
// 为什么要显式检查来源存在：源缺失时必须**报错**，不能静默生成空配置——
// 否则网页版地球会变成空白而没人知道原因。

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'renderer', 'globe-config.source.js');
const OUT = path.join(ROOT, 'renderer', 'assets', 'globe-config.json');

if (!fs.existsSync(SRC)) {
  console.error(`sync-globe-config 失败：找不到来源 ${path.relative(ROOT, SRC)}`);
  console.error('该文件是地球坐标与动画的唯一数据源；缺失时网页版地球将没有标记。');
  console.error('请从 git 历史恢复，或手动重建后重试。');
  process.exit(1);
}

const { WATERS_GEO, CREATURE_3D, GLOBE_ANIM } = require(SRC);

const missing = ['WATERS_GEO', 'CREATURE_3D', 'GLOBE_ANIM'].filter(k => !GLOBE_ANIM || !WATERS_GEO || !CREATURE_3D);
if (!WATERS_GEO || !CREATURE_3D || !GLOBE_ANIM) {
  console.error('sync-globe-config 失败：来源缺少必要字段（WATERS_GEO / CREATURE_3D / GLOBE_ANIM）');
  process.exit(1);
}
void missing;

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify({ WATERS_GEO, CREATURE_3D, GLOBE_ANIM }, null, 2));
console.log('synced →', path.relative(ROOT, OUT));
