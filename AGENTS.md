# AGENTS.md · 项目规则

> 给 AI 与"未来的你"看的精简规则。核心约束尽量短,细节放 `rules/` 按需 @引用。
>
> **接手先读**:[`docs/交接说明.md`](docs/交接说明.md)(运行实例/端口/数据文件/待办的状态快照)。
> 当前版本 **v1.4.58**(见 CHANGELOG)。
> **发包规范**:每次发包只发**平台版(tools-center 托管 zip)+ bat 版(Windows 一键启动 zip)** 两个版本,均上传 GitHub Release(不含数据文件);完整流程见 [`docs/发布规范.md`](docs/发布规范.md)。

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
12. **历史固化(v1.4.32)**:`day_summary` 表(uin+day PK)+ `gcDaySummaries()` 幂等固化 T-2 及更早,保留昨天+今天+最新快照;derive 双源读取(快照日期优先+摘要补齐旧日);备份镜像 `{snapshots, summaries}`;**剥离策略(v1.4.47 修)**:每天保留首末快照组 giftPackages(consumeByPack 只读首末)、中间组剥离(勿改回"仅最新组保留"——会致恢复后包级口径降级、今日已用虚高);wb-last-data.json 非账本已移出 SYNC_FILES
13. **签到检测(v1.4.33)**:官方签到接口被 APISIX 401 拦,用元数据推断——`detectSignIn()` = 最新快照存在「今日首条没有 + cycleEndTime 对日=今天+1自然月」的新增包即为已签到;day_summary.signedIn 固化历史签到,卡片 ✅/⏰ 徽标
14. **前端结构约定(v1.4.38 归位)**:折叠(toggleFold/applyFold)归 core.js(UI 基建),图表 hover 委托(initChartTip)归 chart.js,**副作用一律收敛在 actions.js 启动段**(其余文件只声明函数);改前端后必须 bump wb-gui.html 全部 ?v= 版本戳(一次 bump 到新号,别复用旧号——浏览器强缓存会拦"同名 URL")
15. **图表布局要点(v1.4.34~37)**:日期标签统一 text-anchor="middle" 且 x 夹取防越界(首尾 start/end 锚点会偏 16px);合计柱紧贴账号柱、柱子组整体居中于组;矮柱子靠透明整列触发区(fill="transparent" .cpt)保证 hover 命中
16. **一键同步(v1.4.46)**:`POST /api/webdav/sync` = 先拉(账号 smart 合并 `mergeAccountsSmart` + 历史合并导入)→ 再传(导出全量覆盖);404=首次只传;拉取失败(非 404)中止不上传;**清空保护(v1.4.48)**:远端有账号但合并后本地为空 → 拒绝上传(防云端被清空);**墓碑 TTL 清理在上传成功后执行**(v1.4.51,勿移回合并阶段)
17. **墓碑(v1.4.46,删除跨设备)**:`tombstones(uin, deletedAt)` 表;/api/del 写墓碑随备份传播(远端账号 updatedAt≤deletedAt 不复活、新数据>deletedAt 复活、本地≤deletedAt 删除传播);**清空账号池(/api/clear-data)不写墓碑**(v1.4.48,本地重置不传播);**TTL 30 天清理必须在上传成功后执行**(v1.4.51 P0 修复:禁止在合并阶段 purge——墓碑未传播就被删会导致当次合并误复活 + 远端备份丢删除标记、其他设备删除复活;对齐 edge-multi-account-cookie v2.11.3)
18. **同步/测试前端超时(v1.4.49)**:syncAct 按动作放宽 timeout(sync=90s/test=30s)——后端下载/上传各 60s,默认 15s 会误报超时;新增长耗时接口必须显式传 timeout
19. **favicon(v1.4.50)**:用**内联 SVG data-URI**(`<link rel="icon" href="data:image/svg+xml,<svg ...><text>📉</text></svg>">`,emoji 取 tool.json icon,零文件零后端,子路径自适应);**勿用 staticFile() 读 PNG 文件方案**(已撤回,PNG 二进制会被 utf8 读坏,且多一个文件要同步 4 处)
20. **架构分层(v1.4.58 重构)**:时区工具收敛到 **`src/time.js`**(cnNow/dayKeyOf/dayOfOffset/startOfToday/TZ_MS,全后端唯一口径);历史固化在 **`src/compute/gc.js`**(`gcDaySummaries`,依赖 derive+history 单向);`history.js` **不得 import derive**(v1.4.58 已解循环依赖);`/api/webdav/sync` 业务在 webdav.js 的 `syncNow()`,路由只接线——新增后端逻辑遵守单向依赖(collect→compute→store + time/gc),勿把固化/时区/同步塞回 derive 或路由 handler
21. **UA 受官方风控(v1.4.65,2026-08-16 实测)**:billing 接口只放行特定 `Edg/xx.0.0.0` 占位版本——硬编码 `Edg/148.0.0.0` 被 APISIX 401 拦截,全部账号假性「凭证过期」;实测仅 `Edg/151.0.0.0` 放行(148/150/精确版本均 401)。**打包/发布前必检 `src/config.js` 的 UA 是否当前可用**(实测方法:循环换 `Edg/15x.0.0.0` 请求 billing API 取 200 版本);官方改版后 UA 再失效时重复此流程,详见 `docs/问题记录/官方UA风控致添加凭证401.md`
22. **环境硬编码与调试 Edge 独占(v1.4.65)**:① `USER_DATA` 必须 `os.homedir()` 动态拼(曾硬编码打包机 `C:\Users\2504`,换机器即失效);② **Edge 151:系统已有其他 Edge 实例时,带 `--remote-debugging-port` 的新实例直接退出**——桌面方案必须先清空 msedge 进程再单独启动调试实例(已封装 `start-all.bat`);③ 平台版(file 方案)只在启动时/手动「一键同步」拉 WebDAV,**桌面版续期凭证后需平台版手动同步或重启**,且平台版包 UA 未同步修复时即使拷新数据也 401
23. **配套扩展 `extensions/wb-credits-capture`(免调试浏览器采集 cookie→WebDAV,供工具「一键同步」导入)**:① **manifest 必须声明 `background.service_worker`**,否则 MV3 下 background.js 不注册、popup 的 chrome.runtime.sendMessage 无接收端 → 全部按钮失败(2026-08-20 修通前是死穴);② **WebDAV 路径用原始中文 `workbuddy/workbuddy积分`,与 `src/compute/webdav.js` 的 fileUrl 完全一致,切勿 encodeURIComponent**——否则 NAS 不解码时工具「同步」拉 404、当首次同步清空云端;③ **扩展内 cookie 必须清洗**(已移植 `sanitizeCookieHeader`),扩展自己发 billing 验证请求 + 落库前都洗,否则扩展内验证直接 400 Cookie Too Large;④ 采集用 `chrome.cookies.getAll({domain:"workbuddy.cn"})` 全域名树;⑤ 回归 `test/extension-capture.test.mjs`(mock chrome/fetch 验路径/清洗/合并/MKCOL尾斜杠)。改扩展后 `node --check extensions/wb-credits-capture/background.js`;⑥ **`ensureDir` 建目录的 MKCOL URL 必须以 `/` 结尾**(与 webdav.js `${acc}/` 一致)——部分 NAS/Nginx WebDAV 对无尾斜杠的 MKCOL 直接 409/405,导致建目录失败、同步卡死(典型的「改过很多轮都同步不上」诱因)

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
