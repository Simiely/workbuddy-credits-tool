# DEVELOPMENT.md · 开发文档

> 结构固定三块:**项目概览 → 架构说明 → 关键问题与方案**。
> 本文件是"门面 + 索引",完整架构见 `docs/架构.md`,问题一坑一篇见 `docs/问题记录/`。

## 一、项目概览

多账号采集 WorkBuddy 积分并可视化。核心洞察:**积分包本身静态(总量/到期不变),变化的是"消耗"**——因此系统围绕"剩余积分变化"做数据建模(历史快照 + 折线趋势)。

两条入口共用一套 `lib/` 共享层:

- **CLI**(`wb-credits.mjs`):命令分发,薄层,查询/渲染走共享层
- **GUI**(`wb-gui.mjs`):本地 HTTP 服务 + API 路由,前端 `wb-gui.html/js` 每次请求实时读取
- **子路径挂载自适应**:页面可运行在工具中心等平台 `/tool/<id>/` 子路径下——`__BASE__`(平台注入或自行检测)拼接到所有 `/api/*` 调用前,资源用相对路径;独立运行 `__BASE__=""` 行为不变

关键数字:`CONCURRENCY=6`、单账号超时 8s、前端超时 12s、历史快照上限 500 条、同分钟去重、GUI 端口 8080(顺延 ≤8090)、edge-daemon 8129(HTTP API)/Edge 调试 9222。

## 二、架构说明(摘要)

```
wb-credits.mjs ──┐
                 ├──► lib/query.js(查询编排) ──► accounts / workbuddy / summarize
wb-gui.mjs   ────┤
                 ├──► lib/account-ops.js(添加账号) ──► cookies / workbuddy / accounts
                 ├──► lib/render.js(渲染) ──► accounts
                 ├──► lib/history.js(缓存/历史) / lib/webdav.js(云同步)
                 └──► lib/cookies.js ──► lib/daemon.js ──► edge-daemon.mjs ──► Edge(CDP)
```

模块职责与数据流详见 [`docs/架构.md`](docs/架构.md)。

## 三、关键问题与方案(索引)

| 问题 | 要点 | 详情 |
|---|---|---|
| 刷新按钮无限转圈 | 请求无超时保护,接口挂起时前端永远等 | [刷新按钮无限转圈.md](docs/问题记录/刷新按钮无限转圈.md) |
| 手机号读取错页面 | `phoneFromPage` 固定读第 1 个标签页,可能读错/读空 | [手机号读取错页面.md](docs/问题记录/手机号读取错页面.md) |
| 总剩余口径不含体验版 | 折线/表格只算赠送,与明细卡对不上 | [总剩余口径统一.md](docs/问题记录/总剩余口径统一.md) |
| 历史快照乱序 | 快照顺序错乱导致折线方向颠倒 | [历史快照乱序.md](docs/问题记录/历史快照乱序.md) |
| 浏览器缓存旧 JS | 页面加载修复前代码,表现与代码不符 | [浏览器缓存旧JS.md](docs/问题记录/浏览器缓存旧JS.md) |
| 演示页跨域被拦 | 预览端口请求 8080 无 CORS 被浏览器拦截 | [演示页跨域被拦.md](docs/问题记录/演示页跨域被拦.md) |
| 历史快照同分钟爆炸 | 手动+自动刷新重叠,快照刷爆 | [历史快照去重.md](docs/问题记录/历史快照去重.md) |
| 子路径挂载 JS/API 全 404 | 绝对路径资源/接口在 `/tool/<id>/` 下解析到平台根 | [子路径挂载JS与API全失效.md](docs/问题记录/子路径挂载JS与API全失效.md) |
| edge-daemon 连不上浏览器 | 读 DevToolsActivePort 残留文件,连不存在的 ws 永久挂起 | [edge-daemon连接发现机制.md](docs/问题记录/edge-daemon连接发现机制.md) |
| 云同步快捷按钮一直显示 | `hidden` 属性被内联 `display:flex` 覆盖 | [hidden属性被内联样式覆盖.md](docs/问题记录/hidden属性被内联样式覆盖.md) |
| 今日已用恒为 0 | 聚合 totals 被当天新加账号污染,差值变负 | [今日已用恒为0.md](docs/问题记录/今日已用恒为0.md) |

## 四、每次改动的动作清单

| 场景 | 动作 |
|---|---|
| 改了业务逻辑 | 优先改 `lib/`,CLI/GUI 自动生效;更新本文件对应说明 |
| 踩坑并解决 | `docs/问题记录/` 一坑一篇(与 knowledge-base 同模板)→ 收尾提炼 |
| 改了展示 | CLI 在 `wb-credits.mjs` 底部;GUI 在 `wb-gui.html/js`(前端免重启) |
| 发版 | README(如有变更)+ CHANGELOG 加版本节 |
