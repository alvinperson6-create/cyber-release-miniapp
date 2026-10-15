#!/usr/bin/env node
// 赛博放生 · 陆地轮廓生成
//
// 从 world-atlas land-110m (TopoJSON) 生成浏览器用的简化经纬度轮廓。
// 数据源：https://cdn.jsdelivr.net/npm/world-atlas@2/land-110m.json（NASA/Natural Earth 公共领域）
//
// 用法：node scripts/build-world-land.js [源文件路径]
//   不传路径则从 CDN 抓取；也可以指向本地已下载的 land-110m.json。
//
// 产物：renderer/assets/world-land.json（唯一落地路径）
//
// 历史：这份脚本曾同时产出三处——server/public/（网页）、miniprogram/utils/（小程序）
// 以及依赖已移走的 server/node_modules/topojson-client。
// 前两者都已归档，现在只保留网页端产物，并把依赖换成仓库根的 topojson。
//
// 这是**一次性资产维护**，不是日常检查的一部分；只有要重新生成陆地轮廓时才跑。

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const CDN_URL = 'https://cdn.jsdelivr.net/npm/world-atlas@2/land-110m.json';
const OUT = path.join(ROOT, 'renderer', 'assets', 'world-land.json');

// 依赖已上移到仓库根（node_modules/ 在根目录）
const topojson = require('topojson-client');

async function loadTopo() {
  const arg = process.argv[2];
  if (arg) {
    if (!fs.existsSync(arg)) {
      console.error(`找不到源文件：${arg}`);
      process.exit(1);
    }
    return JSON.parse(fs.readFileSync(arg, 'utf8'));
  }
  console.log('未指定源文件，从 CDN 抓取 →', CDN_URL);
  const res = await fetch(CDN_URL);
  if (!res.ok) {
    console.error(`抓取失败：HTTP ${res.status}`);
    console.error('可改为手动下载后传入路径：node scripts/build-world-land.js /tmp/land-110m.json');
    process.exit(1);
  }
  return res.json();
}

function buildRings(topo) {
  const geo = topojson.feature(topo, topo.objects.land);
  const rings = [];
  // 坐标保留 1 位小数（~11km 精度，对贴图足够）
  const pushRing = ring => {
    const pts = ring.map(([lng, lat]) => [Math.round(lng * 10) / 10, Math.round(lat * 10) / 10]);
    if (pts.length >= 8) rings.push(pts);   // 过滤湖泊级别的小岛
  };
  for (const f of geo.features) {
    const g = f.geometry;
    if (!g) continue;
    if (g.type === 'Polygon') g.coordinates.forEach(pushRing);
    else if (g.type === 'MultiPolygon') g.coordinates.forEach(poly => poly.forEach(pushRing));
  }
  return rings;
}

(async () => {
  const topo = await loadTopo();
  const rings = buildRings(topo);

  if (!rings.length) {
    console.error('解析失败：未提取到任何轮廓。请检查源数据结构是否变化。');
    process.exit(1);
  }

  // 跨太平洋的环由前端按 x 超界断开处理，这里不做拆分
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify({ rings, v: 1 }));

  console.log(`rings: ${rings.length}, json: ${(fs.statSync(OUT).size / 1024).toFixed(0)}KB`);
  console.log('written →', path.relative(ROOT, OUT));
})().catch(err => { console.error(err); process.exit(1); });