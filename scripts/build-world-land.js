#!/usr/bin/env node
// 从 world-atlas land-110m (TopoJSON) 生成简化的经纬度轮廓，
// 输出浏览器用的 world-land.json 和小程序用的 world-land.js
// 数据源：https://cdn.jsdelivr.net/npm/world-atlas@2/land-110m.json（NASA/Natural Earth 公共领域）
const fs = require('fs');
const path = require('path');
const topojson = require(path.join(__dirname, '..', 'server', 'node_modules', 'topojson-client'));

const SRC = process.argv[2] || '/tmp/land-110m.json';
const topo = JSON.parse(fs.readFileSync(SRC, 'utf8'));
const geo = topojson.feature(topo, topo.objects.land);

// 展开为纯多边形环数组，坐标保留 1 位小数（~11km 精度，对贴图足够）
const rings = [];
const pushRing = (ring) => {
  const pts = ring.map(([lng, lat]) => [Math.round(lng * 10) / 10, Math.round(lat * 10) / 10]);
  // 过滤过小的环（湖泊级别的小岛）
  if (pts.length >= 8) rings.push(pts);
};
for (const f of geo.features) {
  const g = f.geometry;
  if (!g) continue;
  if (g.type === 'Polygon') g.coordinates.forEach(pushRing);
  else if (g.type === 'MultiPolygon') g.coordinates.forEach(poly => poly.forEach(pushRing));
}

// 跨太平洋的环拆分：避免经度 -180→180 跳变拉线（贴图绘制时按 x 超界断开即可，这里只标记）
const data = { rings, v: 1 };

const outJson = path.join(__dirname, '..', 'server', 'public', 'world-land.json');
fs.writeFileSync(outJson, JSON.stringify(data));
const outJs = path.join(__dirname, '..', 'miniprogram', 'utils', 'world-land.js');
fs.writeFileSync(outJs, 'module.exports = ' + JSON.stringify(data) + ';\n');
console.log(`rings: ${rings.length}, json: ${(fs.statSync(outJson).size/1024).toFixed(0)}KB, js: ${(fs.statSync(outJs).size/1024).toFixed(0)}KB`);
