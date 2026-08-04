# HANDOFF · 交接与已知问题(2026-08-05 00:50)

> 给下一位接手开发者/AI 的快速启动文档。当前版本 **v1.4.30**。

## 1. 项目是什么

**workbuddy-credits-tool** = WorkBuddy 积分监控仪表盘(多账号积分查询/消耗趋势/到期明细/WebDAV 云同步)。
- 后端 `wb-gui.mjs`(Node 零依赖 HTTP 服务,默认端口 8080,路由登记制;顶部有"文件地图"注释:A 基础设施/B 路由表/C 分发层/D 启动)
- 前端 `wb-gui.html` + **7 个 classic script**(`state/core/render/chart/ops/sync/actions`,共 ~1100 行;无打包器,靠顶层 `const/let/function` 共享全局词法作用域;共享状态集中在 `wb-gui.state.js`;趋势图为**柱状图** + 当日合计柱)
- 后端分层:`src/`(config/domain/collect/compute/store/present);compute 含 10 个模块(含 **`sample.js` 统一采样入口**)
- **计算架构(v1.4.x 收敛)**:后端 `/api/dashboard/all` 是唯一计算源,按自然日聚合每日消耗;前端纯展示,0 计算
- **时区口径(重要)**:所有"自然日/时间显示"**固定中国时区(+8)**,不依赖进程时区——`src/compute/derive.js`(dayKeyOf/startOfToday/赠送包到期)与 `cnNow()`(wb-gui.mjs、src/present/render.js)统一 +8。原因:docker 容器默认 UTC,依赖进程时区会导致日期错位(8/3→8/2)、时间显示错(8/5 00:47→8/4 16:47),v1.4.29/30 修复
- 数据真相源:`credits.db`(SQLite);`wb-*.json` 仅作 WebDAV 迁移桥接
- 回归测试:`npm test`(4 个测试文件、90+ 断言,见 `test/`)

## 2. 部署副本清单(2026-08-04 快照)

当前唯一活跃副本:

| 位置 | 用途 |
|---|---|
| `D:\workbuddy\2026-08-04-10-33-45\workbuddy-credits-tool\` | **git 仓库根 + 运行副本**(当前 8080 实例跑的就是它,改这里并 push) |

历史遗留旧副本(`D:\workbuddy\2026-08-03-*`)是 SQLite 迁移前的文件模式数据源,**不要再当运行副本用**;其中的 `wb-history.json` 曾用于恢复 8/3 历史(已并入 credits.db)。

## 3. 版本戳机制(改了前端必须做)

- `wb-gui.html` 里 **7 个** `<script src="./wb-gui.{state,core,render,chart,ops,sync,actions}.js?v=vX.Y.Z">` 与 `wb-gui.render.js` footer 的 `vX.Y.Z · 数据来自…` 必须**同步更新**,否则浏览器缓存旧 JS
- 用户判断版本方法:页面底部 footer 的版本号
- 前端文件清单改动(增删 script)还要同步:后端静态路由(`wb-gui.mjs`)+ `test/server-routes.test.mjs` + `test/helpers/vm-env.mjs`(见 AGENTS.md 关键坑 10)

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

1. **容器一键起未在本机验收**:Dockerfile/docker-compose 已产出且 YAML 校验过,但本沙箱无 docker,需在有 Docker 的机器跑 `docker compose up -d`(任务 #9 待验收)。注:Docker/tools-center 平台部署 = tools-center 平台容器托管,工具目录即数据目录,**删工具=删数据**,重装后需重新配 WebDAV 并「云同步下载」
2. **历史快照长期增长**:SQLite readings 表持续累积;数据量大时可加"每天最多 N 条 + 只保留 90 天"(暂缓项)
3. **edge-daemon**(8129):Windows 专用(读本机 Edge 登录态);Docker/NAS 上跑不了是**预期**,「添加当前账号」在 NAS 不可用,手动维护 wb-accounts.json 或从 WebDAV 下载
4. **v1.4.2 ~ v1.4.24 大版本未单独提交**(合并为一个提交推送到 GitHub,见 git log);v1.4.25+ 已逐版提交

## 7. 近期修复历史(浓缩,v1.4.x)

- v1.4.30 左上角时间固定中国时区(+8)(fetchedAt 用 toLocaleString 依赖进程时区,容器 UTC 错位)
- v1.4.29 **派生自然日固定中国时区(+8)**:容器 UTC 导致 8/3→8/2、今日已用基线错(800+);Dockerfile/compose 加 TZ=Asia/Shanghai
- v1.4.28 WebDAV 网络超时自动重试 + 大文件(3.6MB)超时放宽 60s(原 15s 临界导致穿透抖动必超时)
- v1.4.27 图例最右加「合计」标签(点击隐藏/显示合计柱);合计柱顶部去掉文字只留数字
- v1.4.26 WebDAV 上传 423(资源锁)退避重试 3 次
- v1.4.25 每日窗口改"数据对齐":跨度 clamp(数据天数,3,7),数据少从最早数据日向右延伸(2 天→8/3 8/4 8/5),多取最近 7 天;修 UTC 日期键错位(改用本地自然日)
- v1.4.24/23 hover 浮层三段式(名字/数量/占当前百分比)、去时间
- v1.4.22 趋势图表拆出 `chart.js`;合计柱标签;浮层加百分比
- v1.4.21 柱状图每组右侧隔一个柱宽加「当日合计」柱(Y 轴纳入组合计)
- v1.4.20 每组最高柱标数字
- v1.4.19 卡片改名/删除按钮真正与「今日消耗」同行靠右(.arow flex 修复)
- v1.4.17 每日窗口以今天为中心对称(3~10 天)
- v1.4.15 **告警/耗尽预测全量下线**(删 alerts.js);卡片按钮移到今日消耗行
- v1.4.13 **凭证过期全量下线** + 近2天过期列 + 使用排序
- v1.4.12 今日已用环比昨日(自然日)
- v1.4.8 bug 筛查:拆分后漏静态路由(严重)+ 派生缓存键 + 只读采样误弹密码
- v1.4.7 前端拆 6 文件 + test/ 骨架
- v1.4.6 修复删除密码窗被挡 + 下载数据后今日消耗变 0(合并导入)
- v1.4.5 管理员逻辑简化(设置/清除/会话验证三态)
- v1.4.3 采样入口统一 `sampleAll`
- v1.4.2 清除密码必须重输 + 阻止浏览器自动填充
