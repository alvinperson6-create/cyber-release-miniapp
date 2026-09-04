#!/usr/bin/env node
// 从 miniprogram/utils/globe-config.js 同步生成 server/public/globe-config.json（网页版使用）
const fs = require('fs');
const path = require('path');
const { WATERS_GEO, CREATURE_3D, GLOBE_ANIM } = require('../miniprogram/utils/globe-config.js');

const out = path.join(__dirname, '..', 'server', 'public', 'globe-config.json');
fs.writeFileSync(out, JSON.stringify({ WATERS_GEO, CREATURE_3D, GLOBE_ANIM }, null, 2));
console.log('synced →', out);
