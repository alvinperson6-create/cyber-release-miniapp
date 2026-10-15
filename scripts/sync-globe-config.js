#!/usr/bin/env node
// 赛博放生 · 地球配置同步
//
// 来源：miniprogram/utils/globe-config.js（小程序端的单一数据源）
// 目标：renderer/assets/globe-config.json（网页版 H5 使用）
//
// 为什么要显式检查来源存在：miniprogram 已进入归档范围，
// 源缺失时必须**报错**，不能静默生成空配置——否则网页版地球会变成空白
// 而没人知道原因。

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'miniprogram', 'utils', 'globe-config.js');
const OUT = path.join(ROOT, 'renderer', 'assets', 'globe-config.json');

if (!fs.existsSync(SRC)) {
  console.error(`sync-globe-config 失败：找不到来源 ${path.relative(ROOT, SRC)}`);
  console.error('miniprogram 已归档。若网页端不再需要地球配置，可删除本脚本与 renderer/assets/globe-config.json；');
  console.error('若仍需要，请先把 globe-config 的数据源迁到 renderer/ 下再恢复本脚本。');
  process.exit(1);
}

const { WATERS_GEO, CREATURE_3D, GLOBE_ANIM } = require(SRC);

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify({ WATERS_GEO, CREATURE_3D, GLOBE_ANIM }, null, 2));
console.log('synced →', path.relative(ROOT, OUT));
