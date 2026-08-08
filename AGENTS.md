# AGENTS.md · 项目规则

> 给 AI 与"未来的你"看的精简规则。核心约束尽量短,细节放 `rules/` 按需 @引用。
>
> **接手先读**:[`docs/交接说明.md`](docs/交接说明.md)(运行实例/端口/数据文件/待办的状态快照)。
> 当前版本 **v1.4.49**(见 CHANGELOG)。
> **发包规范**:每次发包只发**平台版(tools-center 托管 zip)+ exe 版(SEA 单文件)** 两个版本,exe 不上传 GitHub Release;完整流程见 [`docs/发布规范.md`](docs/发布规范.md)。

## 技术栈

- Node.js ≥ 18(开发用 22.x),**纯原生 ESM**,零第三方依赖(`node:http` / `node:fs` / `node:sqlite` / fetch / AbortController)
- 浏览器侧:Edge CDP(WebSocket)→ `edge-daemon.mjs` 独立进程提供本地 HTTP API(仅添加账号用)
- GUI 前端:原生 HTML/CSS/JS,无框架;**7 个 classic script** 共享全局词法作用域;趋势图为自绘 SVG **柱状图**
- 数据真相源:`credits.db`(SQLite);`wb-*.json` 仅作 WebDAV 迁移桥接

## 关键坑(摘要,详情见 @rules/常见坑.md)

1. GUI 前端 7 个文件(`wb-gui.{state,core,render,chart,ops,sync,actions}.js`)**每次请求实时读文件** → 改前端刷新页面即可,无需重启;改 `wb-gui.mjs`/`src/*` 才需重启
2. 前端响应已加 `Cache-Control: no-store` + 全接口 CORS——别删;改了前端必须 bump `wb-gui.html` 里所有 `?v=` 版本戳,否则浏览器缓存旧 JS
3. **所有"总量/剩余"口径 = 体验版基础用量 + 赠送积分**,前端/后端/历史快照/仪表盘必须一致
4. 刷新必须有超时兜底(服务端单账号 8s、前端 12s),按钮状态单点控制,否则会"无限转圈"
5. 历史快照**同分钟去重**(`src/compute/history.js`),读取后必须按时间升序排序(趋势方向)
6. **子路径挂载自适应**:资源用相对路径,API 全部 `__BASE__ + "/api/.."`——否则挂载到 `/tool/<id>/` 后按钮全失效
7. edge-daemon 端口 **8129**(HTTP API)/ Edge 调试 **9222**;发现机制用 CDP 标准(`/json/version`),**勿改回读 DevToolsActivePort 文件**(残留坑)
8. **近1/2/3/7天过期口径**:有效(Status===0)且非"体验版"的赠送包,`CycleEndTime` 距今天 ≤n 天的 `CapacityRemain` 合计。已收口到 `src/compute/derive.js` 的 `deriveGiftExpiry()`(**单派生源**),`/api/dashboard/all` 返回 `expiring1d/2d/3d/7d/giftBuckets/expiryTier`,前端表格/卡片/排序全部消费派生结果
9. **统一采样入口**:`src/compute/sample.js` 的 `sampleAll()` 是唯一"采集→落盘"路径,手动刷新(`/api/all`)与调度器(`scheduler`)都走它;新增写入 readings 的路径必须复用
10. **前端文件清单改动(增删 script)必须同步 4 处**:`wb-gui.html` 引用 / `wb-gui.mjs` 静态路由 / `test/server-routes.test.mjs` 复制正则+断言 / `test/helpers/vm-env.mjs` FRONTEND_FILES——漏一处 `npm test` 就挂
11. **消耗口径 = 已用正增量累加**(`consumeByPos`):官方赠送包数据调整(包消失/重置/新增)会让「首条剩余−当前剩余」漂移成 0,必须按时间扫描快照累计「已用」正增量,包重置时 prev 同步回退点重算(v1.4.31);`consumed` 死字段已删
12. **历史固化(v1.4.32)**:`day_summary` 表(uin+day PK)+ `gcDaySummaries()` 幂等固化 T-2 及更早,保留昨天+今天+最新快照;derive 双源读取(快照日期优先+摘要补齐旧日);备份镜像 `{snapshots, summaries}` 且**剥离历史组 giftPackages 仅最新组保留**(镜像 3.8MB→294KB,上传 7.3s→0.4s);wb-last-data.json 非账本已移出 SYNC_FILES
13. **签到检测(v1.4.33)**:官方签到接口被 APISIX 401 拦,用元数据推断——`detectSignIn()` = 最新快照存在「今日首条没有 + cycleEndTime 对日=今天+1自然月」的新增包即为已签到;day_summary.signedIn 固化历史签到,卡片 ✅/⏰ 徽标
14. **前端结构约定(v1.4.38 归位)**:折叠(toggleFold/applyFold)归 core.js(UI 基建),图表 hover 委托(initChartTip)归 chart.js,**副作用一律收敛在 actions.js 启动段**(其余文件只声明函数);改前端后必须 bump wb-gui.html 全部 ?v= 版本戳(一次 bump 到新号,别复用旧号——浏览器强缓存会拦"同名 URL")
15. **图表布局要点(v1.4.34~37)**:日期标签统一 text-anchor="middle" 且 x 夹取防越界(首尾 start/end 锚点会偏 16px);合计柱紧贴账号柱、柱子组整体居中于组;矮柱子靠透明整列触发区(fill="transparent" .cpt)保证 hover 命中

## 约定

- 业务逻辑一律进 `src/compute/`;CLI/GUI 入口只做分发
- 注释、UI、文档全部中文;文件命名英文,文档中文
- 凭证文件(`wb-accounts.json` / `wb-sync.json` / `wb-admin.json`)与运行数据(`credits.db` / `wb-*.json` / `*.log`)严禁上传,已 gitignore
- **告警 / 凭证过期 / 耗尽预测已全量下线**(v1.4.13/15):不要加回凭证过期展示;派生层只输出前端消费的字段

## 常用命令

```bash
# 回归测试(改动后必跑)
npm test

# 语法校验
node --check wb-gui.mjs && node --check wb-gui.chart.js

# CLI
node wb-credits.mjs accounts          # 账号池
node wb-credits.mjs all               # 批量查询
node wb-credits.mjs save-current      # 添加当前 Edge 登录的账号

# GUI(启动:node wb-gui.mjs;重启:先杀 8080 进程再启)
node wb-gui.mjs
```

## 详细规则(按需 @引用)

- @rules/技术栈.md  @rules/常见坑.md
