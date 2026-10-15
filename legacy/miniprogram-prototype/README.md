# 小程序端原型（已归档）

这是赛博放生的**微信小程序原型**，属于第一代形态。当前产品形态是网页版 H5
（`renderer/index.html`），小程序端不再作为可用入口，也不接入新版 API。

归档日期：2026-10-15

## 为什么归档

- `USE_API = false`：小程序端默认读本地演示数据，从未接入真实后端
  （见 `docs/product-history/2026-09-27-jev-handoff.md`）。
- 交接文档明确「真实小程序 `miniprogram/` 与 `cyber-release-miniapp.html`
  为历史原型，本阶段未接入新版 API，不再作为可用入口展示」。
- 唯一还在被项目引用的资产是地球坐标配置，已迁到
  `renderer/globe-config.source.js`，与消费方同层，不再依赖本目录。

## 数据迁移去向

| 原位置 | 现位置 | 说明 |
| --- | --- | --- |
| `utils/globe-config.js` | `renderer/globe-config.source.js` | 地球坐标与动画的唯一数据源，由 `scripts/sync-globe-config.js` 生成前端产物 |
| `utils/world-land.js` | 不再生成 | 该产物是给小程序用的；网页端直接读 `renderer/assets/world-land.json` |
| `utils/api.js` | 无 | 演示数据层，随原型一并归档 |
| `images/*.svg` | `renderer/assets/images/` | 生物图标在网页端已有对应副本 |

## 如果要恢复小程序端

需要做的不是"把目录搬回来"，而是补齐三件事：

1. **接入真实 API**：重写 `utils/api.js`，对接 `shared/contracts/commands.js`
   定义的命令与 `serving/entrypoints/api-router.js` 的路由。
   注意小程序端需要自己管理会话 cookie（服务端用 `HttpOnly` + `SameSite=Lax`）。
2. **重新生成陆地轮廓**：`scripts/build-world-land.js` 现在只写网页端产物，
   恢复时需加回小程序端的 `world-land.js` 输出。
3. **重新验证**：固定场景与契约测试都以网页端为准，小程序端需要单独的验证手段。

保留本目录只为历史参考，**不要当作现行 API 说明**。