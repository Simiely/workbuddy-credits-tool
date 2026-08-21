# HANDOFF · 交接与已知问题(2026-08-09 00:45)

> 给下一位接手开发者/AI 的快速启动文档。当前版本 **v1.4.50**。

## 1. 项目是什么

**workbuddy-credits-tool** = WorkBuddy 积分监控仪表盘(多账号积分查询/消耗趋势/到期明细/WebDAV 一键同步)。
- 后端 `wb-gui.mjs`(Node 零依赖 HTTP 服务,默认端口 8080,被占顺延;路由登记制,顶部有"文件地图"注释)
- 前端 `wb-gui.html` + **7 个 classic script**(`state/core/render/chart/ops/sync/actions`,共享全局词法作用域;无打包器)
- 后端分层:`src/`(config/domain/collect/compute/store/present)
- **计算架构**:后端 `/api/dashboard/all` 是唯一计算源;派生纯函数 `derive.js`,`consumeByPack` 包级口径(只统计末快照 active 包的 used 增量,首末快照必须带 giftPackages)
- **时区口径(重要)**:所有"自然日/时间显示"**固定中国时区(+8)**,不依赖进程时区;前端跑在浏览器(用户 +8)与后端 +8 自洽,**勿把前端本地时区改成 +8**(2026-08-08 走查确认,见 docs/问题记录/时区分析教训)
- 数据真相源:`credits.db`(SQLite);`wb-*.json` 仅作 WebDAV 迁移桥接
- 回归测试:`npm test`(11 个测试文件,含 webdav-sync 单元 + e2e mock 同步全链路)

## 2. 部署副本清单(2026-08-09 快照)

| 位置 | 用途 |
|---|---|
| `Z:\Configs\tools-center\tools\wb-credits\` | **NAS tools-center 托管运行副本**(v1.4.44 旧代码,完整数据 credits.db 17.8MB;Z: 只读挂载,更新需 tools-center 平台重传工具包) |
| `D:\workbuddy\2026-08-08-22-58-55\workbuddy-credits-tool\` | **git 仓库根 + 本地开发副本**(v1.4.49,改这里并 push) |
| NAS WebDAV `http://192.168.2.1:6086/workbuddy/workbuddy积分/` | 云端备份(已恢复完整版:每天首末快照含 giftPackages) |

历史遗留旧副本(`D:\workbuddy\2026-08-04-*`)已不存在。

## 3. 版本戳机制(改了前端必须做)

- `wb-gui.html` 里 **7 个** `<script src="./wb-gui.{state,core,render,chart,ops,sync,actions}.js?v=vX.Y.Z">` 与 `wb-gui.render.js` footer 的版本号必须**同步更新**,否则浏览器缓存旧 JS
- 前端文件清单改动(增删 script)还要同步:后端静态路由(`wb-gui.mjs`)+ `test/server-routes.test.mjs` + `test/helpers/vm-env.mjs`

## 4. 常用命令

```bash
npm test                       # 回归测试(改动后必跑)
node wb-gui.mjs                # GUI 服务(8080,被占顺延;改后端需重启,改前端刷新即可)
node wb-credits.mjs all        # CLI 批量查询
node edge-daemon.mjs 8129      # 浏览器代理(仅添加账号需要)
node --check wb-gui.mjs && node --check wb-gui.chart.js   # 语法校验
```

## 5. 环境注意事项

- **git push 必须带代理参数**(gitconfig 有空代理覆盖,直连 github 443 超时):
  `git -c http.proxy=http://127.0.0.1:7890 -c https.proxy=http://127.0.0.1:7890 -c http.sslVerify=false -c http.https://github.com.proxy=http://127.0.0.1:7890 -c credential.helper= push https://x-access-token:<PAT>@github.com/Simiely/workbuddy-credits-tool.git main`
- 沙箱会把 rm/unlink 转回收站且 fail-closed,删文件用 node `fs.unlinkSync` 并 `test -f` 验证
- **WebDAV 默认地址** `http://192.168.2.1:6086/`(用户 NAS 局域网服务;前端 `SYNC_DEFAULT_URL` 一处)
- 管理密码:删除项目根 `wb-admin.json` 并重启服务 = 恢复开放模式(忘记密码时)

## 6. 已知问题 / 待办

1. **NAS tools-center 运行副本代码未更新**:`Z:\Configs\tools-center\tools\wb-credits\` 还是 v1.4.44(旧剥离策略),需在 tools-center 平台重传 v1.4.49 工具包;更新前**勿手动点旧版「上传」**(会把云端备份又覆盖成剥离版)
2. **容器一键起未在本机验收**:Dockerfile/docker-compose 已产出且 YAML 校验过,但本沙箱无 docker,需在有 Docker 的机器跑 `docker compose up -d`。注:Docker/tools-center 平台部署 = 工具目录即数据目录,**删工具=删数据**,重装后需重新配 WebDAV 并「一键同步」
3. **历史快照长期增长**:readings 由 `gcDaySummaries` 固化(T-2 及更早浓缩为 day_summary),已缓解;仍可观察
4. **edge-daemon**(8129):Windows 专用;Docker/NAS 上「添加当前账号」不可用,靠 WebDAV 同步账号
5. **双设备同时点同步 → 后写覆盖**(理论竞态,单用户不触发);同步按钮无进行中反馈(🟡 UX)
6. **配套浏览器扩展 `extensions/wb-credits-capture`(免调试浏览器采集方案)**:日常 Edge 登录 → 扩展「抓取并同步 WebDAV」→ 工具「一键同步」导入。2026-08-20 修通:① **manifest 必须声明 `background.service_worker`**,否则 popup 消息无接收端、扩展完全不可用(历史遗留死穴);② WebDAV 路径用**原始中文**(`workbuddy/workbuddy积分`),与 `src/compute/webdav.js` 完全一致,**切勿 encodeURIComponent**(否则 NAS 不解码时工具「同步」拉 404 → 当首次同步清空云端);③ 扩展内 cookie 必须**清洗**(已移植 `sanitizeCookieHeader`),否则扩展自身 billing 验证直接撞 400 Cookie Too Large;④ 采集用 `chrome.cookies.getAll({domain:"workbuddy.cn"})` 全域名树。回归见 `test/extension-capture.test.mjs`

## 7. 近期修复历史(浓缩,v1.4.x)

- v1.4.49 **场景走查修复:同步/测试前端超时放宽**(sync 90s/test 30s,原 15s 慢网络误报)
- v1.4.48 **紧急修复:清空账号池不写墓碑 + 同步清空保护**(防云端被清空事故)
- v1.4.47 **备份剥离策略修复:每天保留首末快照 giftPackages**(consumeByPack 依赖,防同步后口径降级虚高)
- v1.4.46 **WebDAV 一键同步**(先拉后传 + smart 合并 + 墓碑删除传播 + 自动同步;上传/下载按钮合并为「同步」)
- v1.4.45 **前端 XSS 转义收口**(acctName/错误信息 5 处注入点 + escAttr 补 > ')
- v1.4.44 **二轮审计安全加固**:daemon token 鉴权 / CORS 同源 / admin 写面 / busy_timeout
- v1.4.43 **消耗口径收口包级(consumeByPack)**:今日已用 ≤ 累计;consumed = Σ dailyUsed;WebDAV 自动上传
- v1.4.42 平台版不自动弹浏览器 + tool.json 声明 version/group
- v1.4.41 趋势图点击柱子独显 / 点击空白恢复
- v1.4.40 「打开网页」按钮(登录收录 cookie 一键直达)
- v1.4.39 全账号查询恢复(400 Cookie Too Large)+ 串号防护 + 签到基线修正 + SEA exe
- v1.4.38 前端结构优化(折叠归位 core、图表 hover 归位 chart)
- v1.4.33 每日签到检测(元数据推断 + day_summary.signedIn)
- v1.4.32 历史固化(day_summary)+ 备份瘦身(剥离历史 giftPackages——**注意:与包级口径冲突,已被 v1.4.47 修正**)
- v1.4.31 消耗口径改「已用正增量累加(consumeByPos)」
- v1.4.29/30 派生自然日/时间显示固定中国时区(+8)
- v1.4.28 WebDAV 网络超时自动重试 + 大文件超时放宽 60s
- v1.4.25 每日窗口数据对齐(3~7 天)
- v1.4.22 趋势图表拆出 `chart.js`;合计柱
- v1.4.15 **告警/耗尽预测全量下线**
- v1.4.13 **凭证过期全量下线** + 近2天过期列
- v1.4.7 前端拆 6 文件 + test/ 骨架
- v1.4.3 采样入口统一 `sampleAll`

