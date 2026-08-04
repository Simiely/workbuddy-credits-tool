# CHANGELOG

## v1.4.24 (2026-08-04) · hover 浮层改为三段式（名字最上）

- 浮层排版：第一行**名字**(15px)→ 第二行**数量**(26px 粗体)→ 第三行**占当前 X%**(14px 灰)。删除 .ct-top 行内结构。91 断言全过。纯前端无需重启。

> **合并远程提交(2026-08-04 上午,另一环境推送)**：本大提交同时合入远程 1d9f393 / 74c2a32 的增量——
> 浏览器桥客户端双模式(平台托管 CAP_ENSURE_EP 懒加载 + 独立降级直连 8129,合入 `src/collect/daemon-client.js`)、
> 平台接入配置 `tool.json`(tools-center app 型托管,端口 8123)、
> Linux 容器启动兼容(win32 判断 + spawn 静默,已含)、
> `mergeAccounts`(WebDAV 账号池合并导入,补入 `src/compute/store.js`)、
> `DEVELOPMENT.md` 与 `docs/问题记录/edge-daemon连接发现机制.md` 更新。
> 远程对旧 `lib/*` 的 fetch 化/写盘简化等已由 src/ 重构版覆盖,不重复合入。

## v1.4.23 (2026-08-04) · hover 浮层去时间 + 排版重排

- 浮层去掉时间信息;排版改为两行:第一行「数量(26px 粗体) + 占当前 X%(15px 灰)」baseline 对齐,第二行名字(14px)。合计柱显示「110 · 占当前 100% + 当日合计」。91 断言全过。纯前端无需重启。

## v1.4.22 (2026-08-04) · 趋势图表拆分为 chart.js + 合计柱标签 + hover 浮层增强

- **结构**：图表相关（barChart/dayZero/dayWindow/renderLines/toggleLine/changeMode）从 render.js 拆到新文件 **wb-gui.chart.js**（render.js 378→216 行）；HTML 加载 7 个脚本、wb-gui.mjs 静态路由 6→7、server-routes 断言与 vm-env 文件列表同步加 chart.js（并修了 server-routes 复制文件正则漏 chart.js 的坑）。
- **合计柱标签**：合计柱顶部在数字上方加小字「合计」说明（#94a3b8，柱身同色）。
- **hover 浮层增强**：显示「大数字 + 名字 + 占当前 X%（该组合计占比）+ 时间」三行；账号柱渲染时算好 `data-pct`（v/dayTotal），合计柱 data-pct=100；CSS 放大（.ct-v 20→26px、新增 .ct-s 14px/.ct-p 12px、padding 6/10→8/12）。
- **清理**：删 `.acct-foot` 死 CSS；render.js 头注释去"折线"、actions.js 浮层注释同步。
- 验证：npm test 4 文件 **91 断言全过**；首页 7 脚本 v1.4.22；服务已重启（后端路由改动）。

## v1.4.21 (2026-08-04) · 柱状图每组右侧隔一个柱宽新增「当日/当月合计」柱

- 每个时间点（每日=天、每月=月）账号柱右侧**间隔一个柱宽**画一根中性灰（#94a3b8）合计柱 = 该组所有账号消耗之和，`data-n="当日合计"/"当月合计"`，独立 `<g id="line-total">` 不随图例显隐。
- **Y 轴最大值纳入组合计**（否则合计柱超出顶部）；「组内最高只标一个数字」规则改为单柱与合计柱共同参与（合计通常是最高 → 数字标在合计柱顶）。
- 测试 T10 重写（2 账号 30+80：合计 110 标数字、单柱不标、组内 1 个标签）；85 断言全过。纯前端无需重启。

## v1.4.20 (2026-08-04) · 柱状图每组最高的柱子标注数值

- 消耗趋势柱状图：每个时间点（每日=天、每月=月）分组内**最高的柱子顶部标注数值**（`font-weight:700` 加粗、柱同色）；只标一根（同值取先出现者），标签随 `<g id="line-key">` 跟随图例显隐。
- 测试：T1 补最高柱标签断言；新增 T10（2 账号同天对比：最高柱 80 有标签、较低柱 30 无、组内仅 1 个标签），断言用 `font-weight="700">` 特征区分柱顶标签与 Y 轴刻度（`>80<` 会撞上 Y 轴顶部刻度）。84 断言全过。纯前端无需重启。

## v1.4.19 (2026-08-04) · 卡片改名/删除按钮真正与「今日消耗」同行靠右

- **根因**：v1.4.15 把按钮写进了「今日消耗」同一行的 HTML，但 `.arow` 无 flex 布局（只有内部 `.l` 是 flex）→ 按钮实际被换行挤到下一行、`margin-left:auto` 失效。用户看到的效果与代码意图不符。
- **修复**：新增 `.arow.act-row{display:flex;align-items:center}`（含 `.l{flex:1}` / `.acts{flex-shrink:0}`），仅对「今日消耗」行与「查询失败」行启用（带进度条的体验包/赠送包行保持原 column 布局）；按钮经 `margin-left:auto` 靠右。
- 版本戳 v1.4.19；npm test 4 文件 80 断言全过；纯前端改动无需重启。

## v1.4.18 (2026-08-04) · 趋势图改柱状图 + 图例横排到图表上方

- **折线图 → 柱状图**：每日消耗按天分组柱状（每账号一根柱、同账号同色、同账号柱包在 `<g id="line-key">` 内，图例单击隐藏/再点显示逻辑复用）；柱子自带 hover 数据（复用原浮层）；month 模式同样柱状（X 轴按月）。
- **图例横排**：桌面端不再占左侧 150px 竖栏，改为横排多行在图表上方（`.line` column、`.legend` row+wrap、`.lg` width auto），图表全宽更清晰；同时删除标题行残留的「点击图例隐藏折线」提示（v1.4.11 已取消提示但 html 静态 hint 未删）。
- 文件：wb-gui.render.js（barChart 替换 lineChart）、wb-gui.html（CSS + 删 hint），版本戳 v1.4.18。纯前端无需重启。
- 验证：render-lines 测试断言更新（柱状 rect + cpt hover），npm test 4 文件 80 断言全过。

## v1.4.17 (2026-08-04) · 趋势每日窗口改为以今天为中心对称

- 用户反馈：默认应从最左边显示，2 天数据时应显示 8/3、8/4、8/5。此前窗口终点为今天（8/2~8/4），左端多一天空白。
- 修改：dayWindow 以今天为中心对称分布（half = floor((span-1)/2)，i 从 -half 到 span-1-half）——3 天窗口 = 昨天/今天/明天，10 天窗口 = 今天-4 ~ 今天+5；数据点自然从窗口最左开始。
- 文件：wb-gui.render.js（dayWindow），版本戳 v1.4.17。纯前端无需重启。
- 验证：render-lines 测试更新（T1 左=昨天/右=明天；T5 10 天窗口 今天-4~今天+5），npm test 4 文件 80 断言全过。

## v1.4.16 (2026-08-04) · 趋势图例宽度减半 + 账号总览新增「近7天过期」列

- **图例（人名框）宽度减半**：根因是桌面端媒体查询里 `.legend` 固定 150px 竖排且每个 `.lg{width:100%}` 撑满栏宽。改为图例栏 `flex-direction:row;flex-wrap:wrap` 两列排布，`.lg{width:calc(50% - 3px)}`（长名省略号截断）；移动端 `.lg` max-width 100%→50%。
- **账号总览新增「近7天过期」列**：derive.js 新增 `expiring7d = expiringSum(7)` 派生；表格版加列（表头/行/汇总）、手机卡片版与合计卡加 cell、空表 colspan 7→8。
- 文件：derive.js/render.js/html，版本戳 v1.4.16。
- 验证：npm test 4 文件 80 断言全过（T9 补充近7天断言）；实跑派生 expiring7d=1292 生效。服务已重启。

## v1.4.15 (2026-08-04) · 告警/耗尽预测全量下线 + 卡片按钮移到今日消耗行右侧

- **告警引擎整体下线**（用户要求"告警及相关内容代码都不要了"）：
  - 删除 `src/compute/alerts.js` 整个文件（evaluateAlerts/levelOf/evaluateAll）；
  - derive.js：删除 alerts 派生、dailyRate/daysToEmpty（含"即将耗尽"预测）、capacity/remainPct、level 字段及导入；
  - config.js：删除 ALERT_LOW_PCT/ALERT_LOW_DAYS/ALERT_CRIT_DAYS；
  - wb-gui.mjs：删除 /api/alerts 路由、dashboard/all 的 alertsSummary；
  - 前端：state.js 删 alertBadges/alertsSummary、render.js 删 acctAlertStrip/告警徽标/告警芯片/表格告警列、html 删 alert CSS 与 alertSummary 元素、表头"告警"列（colspan 8→7）。
- **卡片布局**：改名/删除按钮从卡片底部移到「今日消耗」同一行右侧（`acts` 靠右），查询失败卡片按钮放错误行右侧。
- 文件：derive.js/alerts.js(删)/config.js/wb-gui.mjs/state.js/actions.js/render.js/html，版本戳 v1.4.15。
- 验证：npm test 4 文件 80 断言全过（server-routes 断言 state.js 改用 derivedOf）；实跑 dashboard/all 无告警/耗尽字段、/api/alerts 404。服务已重启。

## v1.4.14 (2026-08-04) · 修复 v1.4.13 回归：renderDashTable 的 cell 工具函数被误删

- 症状：页面报 `cell is not defined`，刷新失败提示"已显示上次数据"。
- 根因：v1.4.13 清理凭证字段时，误删了 renderDashTable 里 `const cell = ...` 工具函数定义（手机卡片版/合计卡仍在使用），运行时 ReferenceError。
- 修复：恢复 `cell` 定义；新增回归测试 T9（渲染 dashCards/dashTbody 断言"近2天过期"标签与数值存在），防此类"删了还在用的函数"再犯。npm test 4 文件 80 断言全过。版本戳 v1.4.14（纯前端，无需重启）。

## v1.4.13 (2026-08-04) · 凭证过期全量下线 + 近2天过期列 + 当日使用排序

- **凭证过期(sessionExpiresAt/expired)展示与代码全量删除**（用户要求"所有和凭证过期的内容都不需要显示"）：
  - 前端：hero 的"X 个凭证过期"提示、卡片"凭证至 X/⚠️ 凭证过期"标记、仪表盘 dtag 凭证状态、doRefresh toast 的"X 个凭证过期"、fpS/rebuildDash 的凭证字段、footer 文案；
  - 后端：alerts.js 凭证过期/将过期告警规则(cred_expired/cred_expiry)、derive.js 的 sessionExpiresAt 输出、config.js 的 ALERT_EXPIRY_DAYS（连同 JSDoc 注释）。
  - 保留：查询失败统一显示"❌ 查询失败"；采集层 query.js 的 expired 错误归因(内部用,不再展示)。
- **账号总览增加「近2天过期」列**：derive.js 新增 `expiring2d` 派生（expiringSum(2)），表格/手机卡片/合计行同步加入。
- **排序按钮重排为 过期 | 当日使用 | 剩余**：新增 `sortByTodayUsed()`（按 derived.todayUsed 从多到少）。
- 文件：derive.js/alerts.js/config.js/render.js/actions.js/ops.js/html，版本戳 v1.4.13。
- 验证：npm test 4 文件 77 断言全过；实跑派生接口 expiring2d 生效、sessionExpiresAt 已移除、凭证告警 0。服务已重启（后端改动）。

## v1.4.12 (2026-08-04) · 今日已用环比改为「较昨日」（自然日）

- 用户要求：今日已用的 ↑/↓ 箭头应以**昨天**为基准（自然日），而非"上一次刷新的值"。
- 实现：renderHero 从各账号 `derived.dailyUsed` 取昨天（本地自然日 YYYY-MM-DD）的消耗求和作基准，`delta = 今日总消耗 - 昨日总消耗`；昨天无记录则只显示数值不显示箭头（无对比基准）；箭头带 title 提示"较昨日多用/少用 X"。
- 顺带：fpS 指纹加入 dailyUsed 长度（昨日记录出现时 hero 才会重绘刷新箭头）；删除 state.js 死变量 prevTodayUsed。
- 文件：wb-gui.render.js（renderHero/fpS）、wb-gui.state.js（删 prevTodayUsed）、版本戳 v1.4.12。
- 验证：render-lines.test.mjs 新增 T6/T7/T8（上升 ↑488 / 下降 ↓70 / 昨天无记录无箭头），19 断言；npm test 4 文件 77 断言全过。

## v1.4.11 (2026-08-04) · 趋势图例交互简化：单击隐藏/再点显示

- 图例（左侧人名）点击行为改为**单击隐藏该账号、再点一次重新显示**（纯切换）；取消原"单击独显、双击隐藏"。
- 移除图例上方提示文字「单击=只看TA · 双击=隐藏TA」及 `lg-tip` 样式；删除 onLegendClick/onLegendDbl/soloLine 死代码。
- 文件：wb-gui.render.js（图例生成 + toggleLine 保留）、wb-gui.html（删 .lg-tip CSS）、版本戳 v1.4.11。
- 验证：npm test 4 文件 73 断言全过；无残留引用。

## v1.4.10 (2026-08-04) · 趋势图每日窗口动态化：下限 3 天、上限 10 天

- 用户反馈：数据少时无需显示 20 天。每日视图窗口改为**按实际有数据的自然日天数动态取值**：`span = clamp(有数据天数, 3, 10)`，窗口终点为今天。
- 同时**裁剪窗口外的历史数据点**（每日视图只画窗口内；更早的历史由「全部显示」查看），避免窗口外数据点把 X 轴时间轴撑大。
- 文件：wb-gui.render.js（dayWindow 动态化 + renderLines 窗口裁剪）、版本戳 v1.4.10。
- 验证：render-lines.test.mjs 更新为动态窗口断言（1 天数据→3 天窗口 8/2~8/4；15 天数据→10 天窗口 7/26~8/4、今天-10 不出现），15 断言；npm test 4 文件 73 断言全过。

## v1.4.9 (2026-08-04) · 积分消耗趋势：每日视图补全 ±20 天窗口 + 新增「全部显示」

- **每日视图 X 轴补全「今天 ±20 天」刻度**：此前 X 轴只取实际有数据的日期,数据只有 1 天时折线图只画一个孤点。现每日视图补全窗口内每天一个刻度(无数据日只显示日期不画点),折线点归一化到本地当天 00:00 与刻度对齐。
- **新增「全部显示」按钮**(位于「每日」左侧)：显示全部历史数据,不再限制窗口;`changeMode` 支持 day/month/all 三态。
- 文件：wb-gui.html(新增 btnAll + ?v=v1.4.9)、wb-gui.render.js(dayWindow/dayZero/lineChart 支持 xTicks/changeMode 三按钮)、wb-gui.render.js footer。
- **数据核查结论**：readings 表当前只有 2026-08-04(74 行),8 月 3 日数据不在本地(系 v1.4.6 修复前"清空+只导第一条" bug 的遗留后果)。若 8/3 数据存在于云端 WebDAV 备份,点「从 WebDAV 下载」即可用修复后的合并导入补回;本次合并导入与 X 轴窗口补全双管齐下,恢复后历史折线立即完整显示。
- 验证：新增 test/render-lines.test.mjs(每日窗口边界刻度/全部显示/每月/按钮状态,11 断言);vm-env mock 修复 className↔classList 联动。npm test 4 文件 69 断言全过。

## v1.4.8 (2026-08-04) · Bug 筛查修复：拆分后漏静态路由（严重）+ 派生缓存键 + 只读采样误弹密码

系统性筛查发现的 5 个小 bug，全部修复：
- **[严重] 静态 JS 路由漏文件**：v1.4.7 前端拆成 6 个文件，但 wb-gui.mjs 静态路由仍只注册 4 个 → 浏览器请求 `wb-gui.ops.js`/`wb-gui.sync.js` 拿到 200 + `// missing` 占位（空脚本）→ 删除/排序/WebDAV 等函数全部 undefined 崩溃。已补全 6 文件路由（顺序 state→core→render→ops→sync→actions）。
- **[中低] /api/dashboard/all 派生缓存键缺账号池指纹**：原键 = 最新快照时间 + 日期；同分钟去重场景下增删账号后返回旧派生（新账号今日消耗滞后最多 1 分钟）。键追加账号 uin/id 列表签名。
- **[低] 手动采样误弹密码**：`/api/scheduler/run` 是只读采样（后端明确不要求管理员），但前端会话级预验证对所有 POST 生效 → 有密码时点「手动采样」先弹密码窗。已在 api() 预验证排除。
- **[低] sync.js `$("syncQuick").hidden` 无判空**：与 showSyncQuick 统一判空。
- **[低] 前端死代码**：删除从未被调用的 `syncCfg()`（配置读取走后端 loadSyncConfig）。
- 验证：新增 `test/server-routes.test.mjs`（临时副本起服务，断言 6 文件真实返回 + 关键 API，防此类回归）；`npm test` 3 文件 58 断言全过；服务已重启。

## v1.4.7 (2026-08-04) · 架构优化：拆分 actions.js + 沉淀 test/ 回归骨架

- **拆分 wb-gui.actions.js（447 行"杂物抽屉"）**：按职责拆为三个文件（classic script 共享全局作用域，加载顺序 state→core→render→ops→sync→actions）：
  - `wb-gui.ops.js`（新，~190 行）：排序(拖拽/一键) · 明细弹窗 · 改名/删除 · 添加/导出 · daemon 探测 · 清空本地数据；
  - `wb-gui.sync.js`（新，~70 行）：WebDAV 云同步（配置弹窗/测试/上传/下载/清空/快捷按钮）；
  - `wb-gui.actions.js`（~200 行）：刷新编排 · 自动刷新策略(轮询/SSE/兜底) · 🔒 管理按钮状态 · 启动接线（唯一副作用入口）。
- **新增 test/ 回归骨架**（`npm test` 一键跑）：
  - `test/helpers/vm-env.mjs`：node:vm 模拟浏览器环境，真实加载 6 个前端文件（跨文件共享作用域回归）；
  - `test/admin-flow.test.mjs`：管理员三态全流程（设置不算验证/删除首验/会话放行/清除/开放模式）+ 20 个拆分后函数引用检查，35 断言；
  - `test/history-import.test.mjs`：时序导入回归（合并不覆盖/原始 ts 落盘/去重/今日基线），临时目录隔离真实库，8 断言；
  - `test/run-all.mjs`：统一 runner，任一失败非零退出。
- 验证：6 文件 node --check 通过；`npm test` 43/43 通过；首页返回 6 个 v1.4.7 脚本引用；服务在线无需重启（后端未改动，静态文件实时读盘）。

## v1.4.6 (2026-08-04) · 修复：删除时密码窗被确认窗挡住 + 下载数据后今日消耗变 0

- **修复删除时密码窗层级/时序**:`confirmSmall()` 原来在 `await api(...)` 成功后才 `closeSmall()`,导致有密码且未验证时,密码验证窗在删除确认窗(仍开着)后面被挡住。改为点确认后**先关确认窗**再调接口,验证窗必然出现在最前。
- **修复「从 WebDAV 下载」后今日消耗变 0(双 bug)**:
  1. `importLegacy()` 原来 `clearReadings()` 清空整个时序表 → 本地今天的快照(今日消耗基线)被删;改为**合并导入**(不清空,保留今天基线)。
  2. `appendSnapshot()` 原来用「导入时刻」做时间戳,且同分钟去重基于"现在" → 导入的多条历史快照 ts 全挤在当前分钟,去重后**只剩第一条写入**,历史几乎全丢、今天基线只剩一条 → todayUsed=0。改为支持 `opts.ts`(快照原始时间),去重基于快照自身 ts。
- 文件:wb-gui.actions.js(confirmSmall 关窗时序)、src/compute/history.js(appendSnapshot 支持 opts.ts + importLegacy 合并导入)。版本戳 v1.4.6。
- 验证:node --check 通过;临时目录集成测试 9 项断言全过(本地今天快照保留/导入历史按原始 ts 全部落盘/同分钟去重/今日已用=基线-当前=50/无 ts 兜底)。服务已重启(后端模块内存加载,必须重启才生效)。

## v1.4.5 (2026-08-04) · 管理员逻辑简化：设置/清除/会话验证三态

按用户要求简化密码交互（此前清除流程需「二次确认 + 验证以清除」两层弹窗,偏复杂）:
- **「🔒 管理」按钮 = 密码唯一入口**:无密码 → 弹窗直接设置（两次输入一致即启用）;有密码 → 弹窗输入当前密码即清除（单请求 POST /api/admin/clear,body 带 token,后端 readAdminToken 自校验,不再依赖残留缓存）。
- **危险操作(写类接口)会话级验证**:有密码且本次页面会话未验证 → 首次操作弹「输入管理密码」验证一次,通过后本会话内所有危险操作放行;刷新页面后重新验证。无密码 = 完全开放。
- 删除:白色「清除密码」独立按钮、二次确认弹窗、pendingClear 标志、「验证以清除」模式;token 从 localStorage 改为内存变量(刷新即失效,贴合"本次登录")。
- 文件:wb-gui.html(删 adminClear 按钮 + 4 script ?v=v1.4.5)、wb-gui.core.js(openAdmin 三态/confirmAdmin 三态/api 会话预验证)、wb-gui.actions.js(updateAdminBtn 文案)、wb-gui.render.js(footer v1.4.5)。后端零改动(readAdminToken 已支持 body token)。
- 验证:node --check 四文件通过;VM 集成测试真实加载 state+core 两文件,25 项断言全过(T1 无密码→设置 / T2 设置+两次不一致拒绝 / T3 有密码→清除 / T4 危险操作会话首验→重试成功 / T5 会话内二次不弹窗 / T6 验证失败拒绝 / T7 清除 / T8 清除后开放)。
- 修正(用户实测反馈):设置密码成功**不算已验证**,紧随其后的危险操作仍需输入刚设置的密码验证一次(原实现设置后本会话直接放行,与"危险操作本次登录需验证一次"预期不符);会话内验证过一次后仍保持放行。补充 VM 测试 9 项断言(S1 设置后 _sessionAuthed=false / S2 设置后首次删除先弹验证窗 / S3 验证后会话内二次直接放行)。

## v1.4.4 (2026-08-04) · P5 部署：Docker Compose + 桌面启动器

- 新增 `Dockerfile`（node:22-alpine，零第三方依赖，仅 node 内置模块）+ `docker-compose.yml`（一键起，8080 端口，`WB_COLLECTOR=file`，`.:/app` bind mount）+ `.dockerignore`（凭据/数据不进镜像）。
- 新增 `wb-gui.bat` 桌面双击启动器：`%~dp0` 相对定位（修复原 bat 硬编码指向昨日旧目录的失效路径）、`where node` 检测并提示、纯 ASCII。
- 数据互通：桌面(edge) 与容器(file) 共用项目根同一份 `wb-accounts.json` / `wb-sync.json` / `credits.db`，切换无需迁移（docs/部署.md）。
- 验证：Dockerfile/comp.yml/.dockerignore/bat 全 ASCII；docker-compose.yml 经 PyYAML 解析校验通过；wb-gui.mjs 桌面启动已实跑验证。容器一键起需在有 Docker 的机器上验收（本沙箱无 docker）。
- 安全补漏：.gitignore 增加 `wb-admin.json`（明文管理密码文件此前未被忽略，存在误传仓库风险）。

## v1.4.3 (2026-08-04) · 采样入口统一：抽取 sampleAll 抽象（审计 #33）

- **消除重复采样逻辑**:此前 `/api/all`（wb-gui.mjs 路由内）与 `scheduler.js runOnce` 各自实现「fetchAllAccounts → filter(summary) → buildSnapshotEntry → appendSnapshot」,存在重复与漂移风险。新增 `src/compute/sample.js` 唯一入口 `sampleAll({ onSampled })`,两条路径共享:单采集入口（fetchAllAccounts 只在此调用一次）、单落盘入口（appendSnapshot 只在此调用一次）。
- 差异留在调用方:`/api/all` 额外 `saveLastData` 本地缓存 + 直接 render(不传 onSampled,避免与 SSE 刷新风暴);`scheduler.js runOnce` 传 `onSampled` 维护 lastCount/lastError 并驱动 SSE 广播。
- 只读路径 `/api/export.md` 仍直接 `fetchAllAccounts` 生成报告,不落盘,不走 sampleAll。
- 验证:node --check 三文件通过;实跑 8096 端口,`/api/all` 返回真实 6 账号数据、`/api/scheduler/run` 返回 `{ok:true,count:6}`、status.lastCount=6/lastError=null,readings 表落盘 6 行新快照(同分钟去重合并)。

## v1.4.2 (2026-08-04) · 修复：清除密码跳过验密 + 浏览器自动填充绕过两次密码校验

- **修复"清除密码"不弹窗直接清除(实际 bug)**:根因是此前「🔒 管理」按钮做验证时把密码 token 缓存在 localStorage 且不被烧毁(只在随后写操作才烧毁);之后点「清除密码」复用了这个残留 token,`/api/admin/clear` 直接放行。改为:`clearAdmin()` 先二次确认 → 弹窗「验证以清除」要求输入当前密码 → `/api/admin/verify` 校验通过后才调用 `/api/admin/clear`;开始时清掉残留 token,确保每次清除都必须重新输入当前密码(符合预期)。
- **修复"设置时两个不同密码也能成功"(浏览器自动填充)**:两个密码框原为 `autocomplete="off"`,但浏览器密码管家仍会把两个框都填成同一已保存值,使 `v!==v2` 校验"通过",真正落盘的是浏览器填的未知密码 → 后续无法清除。改为 `autocomplete="new-password"`,阻止自动填充,强制手动输入;同时「验证以清除」弹窗也要求手输当前密码。
- 验证:`node --check` 通过;逻辑走查覆盖 设置/验证/清除/取消 各分支。
- 版本戳 html 4 个 script `?v=v1.4.1` → `?v=v1.4.2`(缓存爆破)。

## v1.4.1 (2026-08-04) · 修复"多次刷新今日已用回落为 0"

- **修复刷新瞬间今日已用闪成 0 并永久卡住(前端渲染竞态)**:`doRefresh` 先 `S = all`(派生被清空)再 `renderCards()`/`renderHero()`(此刻 `r.derived` 为空 → 今日已用渲染为 0),随后 `mergeDerived` 才把真实 `todayUsed` 写回。而 `render()` 用 `fpS()` 指纹(含 `todayUsed`)做跳过判断——当本次刷新的值与上一次成功渲染相同,`render()` 判定"未变"直接跳过重绘,导致卡片/hero 永久停留在前面那帧的 0。刷新次数越多越稳定呈现 0。
- **修复方式**:`doRefresh` 在 `S = all` 后,用上一轮 `S.results` 的 `r.derived`(以 uin 为键)回填新账号对象,使即时首屏显示上一次真实值而非 0;`mergeDerived` 到达后用新数据覆盖。即使 `render()` 跳过,显示的也是正确值。派生作为跨刷新缓存,仅在拿到新数据时刷新,语义更清晰。
- 验证:VM 集成测试加载真实 4 个前端文件,模拟两次刷新。修复版两次刷新今日已用均为 20(早期首屏亦 20);对照版(去掉回填)早期首屏=0、最终=0,精确复现 bug。
- 版本戳 v1.4.0 → v1.4.1(renderer footer / html 4 个 script / HANDOFF)。

## v1.4.0 (2026-08-04) · 密码模块审计修复：删除真正落盘 + 敏感操作每次验密 + 清除密码

- **修复"删除提示成功但内容还在"(真实 bug)**:根因 `src/compute/store.js` 的 `saveAccounts` 用 `INSERT OR REPLACE`,只覆盖"仍存在的"账号,被删账号残留在 SQLite 表中,`/api/all` 重读又拉回。改为**先 `DELETE FROM accounts` 再插入**(事务包裹),成为真正的全量覆盖,删除/重排/改名均正确持久化。
- **敏感操作每次重新验密**:原 `api()` 把明文密码缓存在 `localStorage`、全会话自动附带 `X-Admin-Token`,导致设置密码后所有写操作(删除/清空/配置)静默放行、不再弹窗。改为 `api()` 收到 `needAuth` 时弹出密码窗、经 `_adminGate` 闸门等待验证通过后再重试原请求;验证成功后**清除 token**,下一次写操作再次要求密码。集中在 `api()` 一处,所有 `admin:true` 写接口统一受益;`confirmAdmin`/`closeAdmin` 联动解析/拒绝闸门。
- **新增"清除密码"模块**:后端 `/api/admin/clear`(删除 `wb-admin.json`、置空 `adminPass`,`admin:true` 需先验证当前密码);前端管理弹窗"已启用"态新增「清除密码」按钮(`clearAdmin()` + `cfm` 二次确认),`updateAdminBtn` 联动。
- 验证:`node --check` 全过;VM 行为测试覆盖 saveAccounts 覆盖写入、api needAuth→闸门→重试→清 token、clear 流程。
- 版本戳 v1.3.9 → v1.4.0(renderer footer / html 4 个 script / HANDOFF)。

## v1.3.9 (2026-08-04) · 支线可读性重构：cfm 去全局状态、applyAuto 抽策略(无行为变更)

- **`cfm` 去全局状态**：原实现用全局 `cfmResolve` + `closeSmall` 兜底 resolve(false)，存在"先 resolve 再关否则误吞 true"的易错点。改为每次调用自建 `Promise` 与局部 `resolve`，确认/取消按钮用 `.onclick` 局部闭包绑定，✕/遮罩关闭经 `smallCloseHook` 统一走"取消"，彻底消灭全局变量与兜底竞态。`closeSmall` 现按 `smallCloseHook` 分派（普通弹窗如改名为 null 仅关闭）。删除 `cfmRes`。
- **`applyAuto` 抽策略**：原三分支（显式轮询 / SSE 推送 / 5 分钟兜底）混在 `if/return` 中。新增 `pickStrategy()` 返回 `'poll' | 'sse' | 'fallback'` 枚举，`applyAuto` 按策略拍平，意图一眼可读。
- 验证：`node --check` 全过；`cfm` 三种关闭路径（确认/取消/✕）均单发 resolve 且取值正确；`pickStrategy` 三态映射正确。
- 版本戳 v1.3.8 → v1.3.9(renderer footer / html 4 个 script / HANDOFF)。

## v1.3.8 (2026-08-04) · 收口双数组：dashPer 改为 S.results 的投影(无行为变更)

- **架构收口(接 v1.3.7)**:`S.results` 与 `dashPer` 仍是两个平行数组、靠 `mergeDerived` 用 uin 桥接,存在"拖拽排序后卡片重排、仪表盘表格不跟着重排"的不一致,以及 uin 不匹配时静默缺数据的风险。
  - 改为:`mergeDerived` 在把派生合并进 `r.derived` 后,**直接由 `S.results` 投影重建 `dashPer`**(只带展示字段 + `expired`/`sessionExpiresAt` 凭证状态);仪表盘表格/折线现在与卡片同序同源,手动排序后两者一致。
  - 删除 `renderDashTable` 内冗余的 `credMap` 桥接(原本再从 `S.results` 按 uin 查凭证状态),改用投影已带的 `a.expired`;同步清理 `state.js`/`render.js`/`actions.js` 内指向旧双数组设计的注释。
  - 后端 `/api/all` 与 `/api/dashboard/all` 同源于 `loadAccounts()`,账号集合一致,投影不会丢账号。
- 验证:`vm` 拼接 4 文件实跑断言全过;起服 8080 实测两接口 200、`render()` 无异常、拖拽排序后表格跟序。
- 版本戳 v1.3.7 → v1.3.8(renderer footer / html 4 个 script / HANDOFF)。

## v1.3.7 (2026-08-04) · 前端数据架构重构：单一数据源(无行为变更)

- **核心重构(非补丁)**:消除「双数据源竞态」——原 `S`(`/api/all`)与 `dashPer`(`/api/dashboard/all`)两套数据,且 `dashPer` 通过 `syncCardsToday`/`syncHeroExpiry`/`syncCardsAlerts` 命令式 patch 回卡片/hero DOM,新人难以判断"卡片上的今日消耗到底被谁写"。
  - 改为:`doRefresh` 同时取两份数据,`mergeDerived()` 把仪表盘派生(按 uin)合并进每个账号对象 `r.derived`;**所有渲染只读 `r.derived`**,`render()`/`renderDash()`/`renderDashTable()`/`renderLines()` 全部为纯函数、自身不再发请求。
  - 删除 `syncCardsToday`/`syncHeroExpiry`/`syncCardsAlerts`/`buildTodayUsedMap`/`fpDash` 及全局 `todayMap`/`alertMap`/`lastDfp`; `fpS` 指纹纳入派生字段,派生就绪后卡片自动重绘。
- **死代码清理**:`wb-gui.core.js` 移除 `adminPendingResolve` 占位变量、`api()` 内"从请求体抠 token"的兜底分支、`confirmAdmin` 内 `typeof updateAdminBtn === "function"` 探测(改为直接调用)。
- **图例交互**:`onLegendClick` 手写 300ms 定时器区分单/双击 → 改为浏览器原生 `ondblclick="onLegendDbl(...)"`,删 `lgLastKey/lgLastTime/lgTimer`。
- 验证:`vm` 拼接 4 文件实跑断言全过(派生合并正确、渲染无 ReferenceError、今日消耗/近3天过期从 `r.derived` 读取);起服 8080 实测 `/api/all`+`/api/dashboard/all` 200、`render()` 无异常。
- 版本戳 v1.3.6 → v1.3.7(renderer footer / html 4 个 script / HANDOFF)。

## v1.3.6 (2026-08-04) · 管理员密码改为「默认不启用,首次点击可设置」

- **行为变更**:管理员密码不再依赖环境变量 `GUI_ADMIN_PASS`,改为**运行时由前端「设置密码」持久化到 `wb-admin.json`**,默认未启用(写操作自由)。
  - 默认状态:🔒 按钮显示「设置密码」,点击打开「设置密码」弹窗(密码 + 确认两栏),设置后所有写接口(增删账号/重命名/清空/WebDAV 配置等)需输入密码。
  - 已启用状态:🔒 按钮显示「管理」,点击打开「输入密码」弹窗,验证通过后方可执行写操作。
- **后端**:`wb-gui.mjs` 启动从 `wb-admin.json` 读密码(空=开放);新增 `POST /api/admin/setup`(首次设置,≥4 位)与 `POST /api/admin/verify`(验证密码);`/api/admin/status` 返回 `enabled` 字段;`adminDenied` 改为比对文件密码。
- **前端**:`wb-gui.core.js` 的 `openAdmin()` 按 `adminEnabled` 切换「设置/输入」两态;`confirmAdmin()` 设置时校验两次一致并调用 setup、输入时调用 verify;`wb-gui.state.js` 新增共享状态 `adminEnabled`;`wb-gui.actions.js` 的 `checkAdminStatus()` 据 `/api/admin/status` 更新按钮文案。
- 移除 `src/config.js` 的 `GUI_ADMIN_PASS` 导出及其 env 依赖。
- 版本戳 v1.3.5 → v1.3.6(renderer footer / html 4 个 script / HANDOFF)。

## v1.3.5 (2026-08-04) · 修复 WebDAV 登录失败(密码被意外清空)

- **根因**:前端 `openSync()` 打开同步弹窗时无条件清空密码框,用户未重输密码就点「保存配置」→ 空密码发往后端;后端 `/api/webdav/config` 又无条件覆盖 `pass` → 已保存的密码被清空 → 之后连接测试/上传/下载均用空密码 → 401 登录失败。
- **修复**:
  - 后端保存配置时,若传入 `pass` 为空且已有配置含非空密码,则**保留原密码**(清空配置仍走「清空配置」按钮,整体删除 `wb-sync.json`)。
  - `src/compute/webdav.js`:401/403 现在返回明确提示「WebDAV 登录失败：用户名或密码错误」,不再含糊报「创建目录失败」。
  - 前端 `openSync()`:密码框在已有配置时显示占位「留空则保留原密码」,避免误清空。
- 验证:本地 mock WebDAV 实测——正确密码连接成功;空密码再保存后密码保留(不再被清空);错误密码提示明确。

## v1.3.4 (2026-08-04) · 前端拆模块(纯重构,无行为变更)

- **前端巨石拆分**:原 `wb-gui.js`(962 行单文件)拆为 4 个 classic `<script>`,无打包器,靠顶层 `const/let/function` 共享全局词法作用域:
  - `wb-gui.state.js`(共享状态/常量/`escAttr`/`derivedOf`/`expiryTier` 等纯 helper)
  - `wb-gui.core.js`(网络 api + 通用 UI 反馈/遮罩/管理员鉴权)
  - `wb-gui.render.js`(纯渲染:Hero/卡片/仪表盘/表格/折线/到期柱图/增量同步)
  - `wb-gui.actions.js`(用户动作/弹窗/生命周期/启动接线,须最后加载)
- 服务器 `wb-gui.mjs` 路由由单 `/wb-gui.js` 改为 4 条静态路由;`wb-gui.html` 顺序加载 4 个 script
- 旧 `wb-gui.js` 已删除;`node --check` 4 文件全过;inline `onclick` 处理器全部解析到全局 `function` 声明
- 注意:本重构不改任何用户可见行为,版本戳仅因"改了前端"按 HANDOFF 约定 +1

## v1.3.3 (2026-08-04 02:00) · 确认弹窗修复(下载/清空恢复)

- **严重:确认弹窗点「确定」无效**(v1.3.0 引入):`cfmRes()` 先调 `closeSmall()` 再 resolve,而 `closeSmall` 的兜底 `cfmResolve(false)` 抢先执行 → 点确定实际=取消 → **WebDAV 下载、清空数据全部被"已取消"**
- 修复:先 `cfmResolve(v)` 再 `closeSmall()`;兜底仅在遮罩/✕ 关闭时触发
- 单测:确认→true / 取消→false / 遮罩→false 全通过

## v1.3.2 (2026-08-04 01:56) · WebDAV 默认地址 + 空账号显示

- WebDAV 默认地址 `https://w2e0b1d6av.ddnsto.com`(内网穿透,NAS 不可达)→ **`http://192.168.2.1:6086/`**(前后端统一,链接框留空即用默认)
- 空账号池时 footer 不再被清空(显示版本号 + 引导文案)
- 空账号手动刷新提示「暂无账号数据」,不再误报「已是最新无变化」

## v1.3.1 (2026-08-04 01:52) · 自动刷新免闪屏

- 数据指纹 `fpS()`/`fpDash()`:刷新时比较,未变则跳过 hero/卡片/表格/折线重绘(节点保留 → 拖拽事件与滚动位置自然保留)
- 手动刷新无变化时 toast「✅ 已是最新数据(无变化)」

## v1.3.0 (2026-08-04 01:40) · 模块化重构(子代理全量审核后执行)

- **P0**:cfm 确认弹窗遮罩关闭不 resolve → Promise 悬空 → 上传/下载永久失效;`closeSmall` 兜底 `cfmResolve(false)`
- 弹窗显隐统一 `openMask/closeMask`(4 个 mask 共用)
- 拖拽排序去重 → 统一 `saveOrder(ids, okMsg)`
- 内联样式抽 CSS 类(`.bar-*/.ph-sm/.t-faint/.t-bad/.btn-lg/.num-b/.row-total/.tbl-short` 等):33 处 → 11 处(仅动态值)
- 两段式渲染合并:`todayMap/prevTodayUsed` 模块级变量替代 `window.*`
- 清死代码:`mergeAccounts/deleteFile/sleep/后端 totals/残留 .bucket CSS`
- ⚠️ 过程事故:脚本清理 CSS 误删 HTML 大段,已 git 恢复并改用精确编辑重做

## v1.2.1 (2026-08-04 01:28) · 审核修复

- `data-n` 账号名 HTML 属性转义(escAttr)防注入
- 单点账号补 hover 区(悬浮大数字)
- dashboard 缓存键加本地日期,跨午夜自动失效

## v1.2.0 (2026-08-04 01:25) · 计算架构收敛

- **后端唯一计算源**:`/api/dashboard/all` 按自然日(本地时区)统一聚合 → series 直接返回每日消耗;`todayUsed` 与折线图同源
- 前端删 `toLocalKey/aggregateConsumption` 死代码,纯展示

## v1.0.16 (2026-08-03) · 手机端 UI 大修 + 性能优化 + CSS 恢复

### 手机端 UI
- **账号总览重设计**:手机端每账号一卡(渐变顶条 + 总剩余大数字 + 2×2 指标网格 + 凭证状态),桌面保持 7 列表格
- **2 列网格**:手机端账号总览改为 `grid-template-columns:1fr 1fr` 紧凑卡,合计卡跨整行,消除大面积空白
- **断点同源根治**:JS 同时渲染卡片+表格两套 DOM,CSS media query 决定显示哪套(删除 JS 分支判断与 matchMedia 监听),彻底消除"JS/CSS 不同步 → 表格 td 挤成一坨"问题
- **布局**:自动刷新控件移到操作条「导出 MD」后,顶栏只留品牌+刷新(手机一行)
- 拖拽排序触屏禁用(`matchMedia("(hover:none)")`);hero 手机 2x2 均分

### 修复
- **严重:CSS 丢失**(此前脚本批量替换误删):
  - 弹窗/抽屉类:`.mask/.sheet/.shead/.sbody/.toast/.finput/.factions/.tip`(4 个弹窗曾裸显示在页面流)
  - 明细弹窗内:`.cards/.mcard/.sect/.stitle/.bucket/.bh/.bd/.bday*`
  - 账号卡片列表:`.grid/.acct*/.remain/.acct-rows/.arow/.meter/.acct-foot/.empty/footer` 共 22 条
  - 已从 git 历史完整恢复,并加 Python 审计脚本比对(JS 引用 class vs CSS 定义,0 缺失)
- `cell is not defined` 作用域 bug(定义在 map 回调内,合计卡用时已出作用域)
- 首屏长时间"加载中" → 缓存秒开 + 后台刷新

### 性能
- **首屏缓存秒开**:启动先加载 `/api/last` 本地缓存渲染,再后台 `/api/all` 实时覆盖;手动刷新强制实时
- **超时分级**:批量刷新 30s,其他请求 15s(≥12 账号时旧 15s 会被查询时长打爆)
- **dashboard/all 内存缓存**:按 wb-history.json mtime 失效,命中 0.2s
- **缓存异步写**:history.js 写盘队列(fs.promises),610KB 缓存不阻塞事件循环
- **后端健壮性**:body 1MB 限流、`/api/status` daemon 探测 2.5s 超时、edge-daemon CDP send 15s 超时+清理 pending
- **防缓存**:html meta no-cache + JS 引用版本戳 `?v=v1.0.6`
- 常量统一:删 `MAX_HISTORY`,用 util.js `HISTORY_LIMIT`

### 变更
- 原生 `confirm()` 全部改自定义 `cfm()` Promise 弹窗(复用 smallMask,与 tools-center 风格一致)
- hero「今日已用」初始 0(非 —);删死代码 `shortName`

## v1.0.15 (2026-08-03) · 模块化重构 + UI 优化 + 多项修复

### 重构
- **前后端模块化**:后端 per 新增 `todayUsed` 字段预计算,删除前端 `updateTodayUsed`/`buildTodayUsedMap` 两处重复计算;`renderLines` 提取通用 `aggregateConsumption(pts, keyFn)` 消除 day/month 40 行重复代码
- **bot排序逻辑分层**:`expiryTier` 逐层扫描(1~30天),近1天过量优先,再无压力按总剩余垫底;p `persistOrder` 复用保存机制
- **findAccount 修复**:纯数字 key 先精确匹配 uin 再按序号,解决 uin 查询 404

### 修复
- 消耗历史 `/api/history?account=<uin>` 返回 404(纯数字 uin 被误判序号)
- 折线图单天聚合丢失数据点 → `aggregateConsumption` 保证每天一个消耗点
- 按月模式耗值恒为 0 → first/last 方向修正
- 累积已用(used)数据不可靠 → 日消耗改为剩余差值计算
- 折线图单点标签顶部裁切 → 顶留白 34px + 标签位置调整

### 变更
- **按钮文案**:「近1天过期排序」→「过期排序」;趋势面板「按天/按月」→「每日」「每月」按钮
- **布局**:操作按钮下移至账号卡片上方;云同步按钮留顶部
- **消耗历史按自然日聚合**:明细弹窗表格每天一行(起/终/日消耗)
- **折线图**:标题→「📉 积分消耗趋势」,x 轴中文标签,单点 r=1
- 删除死代码:`todayExpiringOf`、`.sep` CSS、`agg` 函数

### 新增
- **云同步清空配置**:弹窗内「🗑 清空配置」删除本地 WebDAV 登录信息
- **账号卡片今日消耗**:刷新后卡片显示各账号今日消耗数
- **Hero 变化趋势**:今日已用旁显示 ↑+N / ↓-N 变化量
- **折线图 hover 提示**:悬停显示时间+消耗量
- **近3天过期加粗**:有过期量的账号数字加粗提醒
- **图例滚动**:账号多时 max-height 200px
- **面板刷新时间**:趋势面板显示"6 个账号 · 08-03 18:11"
- 密码框回车保存云同步配置,消耗标记点缩小

## v1.0.14 (2026-08-03) · 到期预警 + 交互优化 + 换 AI 交接

### 新增
- **账号总览表格新增 3 列**:今日消耗 / 近1天过期 / 近3天过期(含合计行;近1/3天过期取 `CycleEndTime` 距今天 ≤1/≤3 天的有效赠送包剩余,今日消耗取该账号今日最早→最新快照差值)
- **Hero 卡片**:「今日会过期」→「近3天过期」;固定 4 卡布局(宽屏 1 行 4 列、窄屏 2×2,消除 auto-fit 临界跳行)
- **明细弹窗到期柱状图**最前面新增 2 根:1天到期(今+明,红色)/ 3天到期(至3天后,橙色),数值与表格列一致
- **操作条新增「⏰ 近1天过期排序」**:按 1 天内到期积分从多到少一键排序并持久化
- **消耗趋势图消耗标记点**:数据点相对上一快照剩余下降(当天有消耗)时画散点标记,不连线;右上角注「● 当日/当月有消耗」(按天/按月视图文案自适应)

### 变更
- **操作条布局重构**:移除左右分组(`.ops-l`/`.ops-r`),全部按钮平铺一条流,`flex-wrap` 自适应换行(最多 2 行,超出纵向滚动);按钮文字不再因窄屏隐藏(删 `.ops .txt{display:none}`)
- `.btn` 加 `flex-shrink:0`:每个按钮为完整单元,不压缩、emoji 与文字不拆开
- 按钮文字精简:添加当前账号→添加账号;总剩余排序→剩余排序
- 排序逻辑泛化:`sortByTotal` 重构为 `sortByMetric(getV, label)`,剩余排序与近1天过期排序共用一套保存机制

### 修复
- Hero 卡片 auto-fit 在宽度临界值时 1 行/2 行反复跳变 → 固定 `repeat(4,1fr)`(≥640px)/ `repeat(2,1fr)`(<640px)

### 文档
- README / DEVELOPMENT / AGENTS / `docs/交接说明.md` 同步至 v1.0.14

## v1.0.13 (2026-08-03) · 交接文档

### 文档
- 新增 [`docs/交接说明.md`](docs/交接说明.md):接手者快速上手(三处同步/端口/数据文件/命令/核心约定/待办/文档地图)
- AGENTS.md 顶部指向交接文档,标注当前版本 v1.0.12
- rules/常见坑.md +2(聚合指标被加账号污染、不要补丁套补丁)
- docs/问题记录/ +1(今日已用恒为 0,与 v1.0.7 修复对应)
- DEVELOPMENT.md 问题索引同步

## v1.0.12 (2026-08-03)

### 重构
- **操作条布局改为标准 flex 分组**:移除中间 `flex:1` 幽灵占位元素,左组(`.ops-l`)/右组(`.ops-r`)各为 flex 子项,用 `margin-right:auto` 做弹性两端对齐——无补丁、纯 flexbox 原生机制
- 保留:单行不换行(`nowrap`)、超宽可水平滑动(`overflow-x:auto`)、窄屏只显示 emoji

## v1.0.11 (2026-08-03)

### 修复
- **操作条窄屏换行**:之前 `flex-wrap:wrap` + 中间 `flex:1` 占位在窄屏把右组挤到第二行 → 改为 `flex-wrap:nowrap` + `overflow-x:auto` 强制 1 行,内容超出可水平滑动
- 左组靠左、右组靠右的两端对齐保留

## v1.0.10 (2026-08-03)

### 变更
- **操作条按钮响应式**:窄屏(≤640px)只显示 emoji,文字隐藏(`.ops .txt{display:none}`),方便手机使用
- 按钮结构:`<span class="em">emoji</span><span class="txt">文字</span>`,宽屏显示完整,窄屏只余 emoji
- 操作条 5 个按钮已全部包 span(添加/排序/清空/导出/云同步);云同步已配 WebDAV 时右侧 3 个纯 emoji 快捷按钮不受影响

## v1.0.9 (2026-08-03)

### 变更
- **操作条简化为两端对齐**:移除两个竖线分隔(sep),用 `flex:1` 占位,左组(＋添加 / 📊排序 / 🧹清空 / 📝导出)靠左,右组(☁️云同步 + 快捷按钮)靠右,中间留白
- `.sep` 样式已无引用,保留无影响(后续清理)

## v1.0.8 (2026-08-03)

### 变更
- **首页操作条云同步快捷按钮改纯 emoji**:去掉"测试/上传数据/下载数据"文字,只保留 🔌 ⬆️ ⬇️(更紧凑);加 `title` 悬停提示(测试连接/上传数据/下载数据),不影响功能
- 弹窗内的同名按钮保留文字(弹窗空间充足,文字更清晰)

## v1.0.7 (2026-08-03)

### 修复
- **「今日已用」恒为 0**:原算法用全账号聚合 totals 的"今日最早−最新",但**当天新加入账号会让聚合总量跳增**(如 4227→28898),差值变负 → 显示 0
  - 改为**按账号分别计算**(该账号今日最早快照总剩余 − 最新,>0 计入再求和),新账号加入只贡献自身消耗,不再污染总量
  - 实测:今日已用 486(正确反映今天消耗)

## v1.0.6 (2026-08-03)

### 变更
- Hero 第 2 块「账号」→ **「⏳ 今日会过期」**:所有账号中到期日为今天的有效赠送包剩余积分合计(基于 `CycleEndTime` 日期比对)

## v1.0.5 (2026-08-03)

### 变更
- **Hero 总览区改等宽 4 块**(手机 2×2、桌面 4 列,每块大小一致,手机浏览正确换行):
  ① 总剩余积分(含状态文本)② 账号 ③ **今日已用**(新,基于历史快照:今日最早−最新总剩余)④ 累计已用
- 「凭证过期」不再单独成块(其信息已并入状态文本:⚠️ N 个凭证过期),总剩余数字 38px→30px 适配等宽块

## v1.0.4 (2026-08-03)

### 修复
- **云同步快捷按钮(测试/上传/下载)显示逻辑**:`syncQuick` 的 `hidden` 属性被内联 `style="display:flex"` 覆盖(内联样式优先级更高),导致未配置 WebDAV 也一直显示
  - 移除内联样式,改 CSS 控制:`#syncQuick{display:flex}` + `#syncQuick[hidden]{display:none !important}`
  - 验证:未配置 → hidden(不显示);已配置 → 显示。保存配置/测试成功/页面加载检测到配置三条路径均触发显示

## v1.0.3 (2026-08-03)

### 修复
- **edge-daemon 连接发现机制重写**:弃用读 `DevToolsActivePort` 文件(可能残留旧 uuid,连不存在的 ws 路径永久挂起),改为标准 CDP 发现——轮询 `GET :9222/json/version` 取真实 `webSocketDebuggerUrl`
- 修正常驻子进程端口失效:改 lib/util.js 后需重启进程(模块加载时读值)

### 变更
- 全部 daemon 端口 **9333 → 8129**(lib/util.js / lib/daemon.js / edge-daemon.mjs / edge-ctl.mjs):daemon HTTP API 8129(平台端口段内,可被 tools-center 托管)、Edge 调试端口 9222(默认,EDGE_DEBUG_PORT/argv[3] 可覆盖)
- 前端 daemon 提示文案场景化:工具中心挂载 → 指向接入 edge-daemon 工具;独立运行 → 指向 `node edge-daemon.mjs 8129`

## v1.0.2 (2026-08-03)

### 新增
- **子路径挂载自适应**:页面可在工具中心等平台 `/tool/<id>/` 子路径下运行
  - `wb-gui.html`:`__BASE__` 自动检测注入 + script 改相对路径 `./wb-gui.js`
  - `wb-gui.js`:15 处 API 调用全部 `__BASE__ + "/api/.."` 前缀化(独立运行 `__BASE__=""`,行为不变)

### 修复
- 挂载到子路径后 JS/API 绝对路径 404 → 所有按钮失效的问题

## v1.0.1 (2026-08-03)

### 新增
- 账号卡片**拖拽排序**:HTML5 DnD,拖到目标卡片即换位,顺序保存到账号池(`/api/reorder`)
- 操作条「📊 总剩余排序」按钮:按总剩余积分从多到少一键排序(失败/过期账号排后),同样持久化

### 修复
- 明细弹窗错位:卡片点击由渲染索引改为**账号 id 定位**,拖拽/排序后点哪张开哪张

## v1.0.0 (2026-08-03)

首版发布。多账号 WorkBuddy 积分采集与仪表盘,CLI + GUI 双入口,共享 `lib/` 模块层。

### 核心功能
- 多账号池(每账号独立 cookie,按 Uin 去重,显示名自定义,凭证到期提醒)
- CLI:save-current / accounts / rename / del / all / 单账号查询(--json / --csv)
- GUI 仪表盘:倒金字塔布局(状态层 → 消耗趋势 → 账号明细)
  - 状态层:总剩余大数字 + 状态色(正常/查询失败/凭证过期)
  - 消耗趋势:表格版(含合计)+ 折线版(每账号一条,图例点击隐藏/显示,按天/按月聚合)
  - 账号卡片:右上角两行"总剩余积分"徽章,体验版/赠送进度条,点击钻取明细
  - 明细弹窗:统计卡(剩余总积分)/ 7 天到期柱状 / 到期列表 / 消耗历史表
- 消耗历史:每次刷新记快照(同分钟去重,上限 500),折线/表格跟踪剩余变化
- 本地缓存(`wb-last-data.json`):离线可看,打开页面先显缓存再后台刷新
- WebDAV 云同步:账号池+历史+缓存上传/下载到 `workbuddy/workbuddy积分/`(自动建多级目录)
- 导出 MD 报表(按账号分节)、导出 CSV(CLI)
- 自动刷新(间隔可调,localStorage 记忆)、清空本地数据(分项勾选+二次确认)
- 演示模式:`window.__DEMO__` 存在时直接用内嵌快照渲染,离线可看

### 体验优化
- 深色粉红主题(#ff9292 主色,主色图形上文字用 #2d1a1a),移动优先响应式(手机/平板/桌面)
- 按钮分组布局;toast 提示统一顶部居中(深色卡片)
- 前端文件实时读取(改前端免重启);no-store 防缓存;全接口 CORS

### 架构
- 两轮模块化重构:业务全部收敛到 `lib/` 共享层(11 个模块),CLI/GUI 入口为薄层
- 消除重复:查询编排(CLI/GUI)、添加账号、渲染(markdown/MD/CSV)、摘要、常量集中

### 修复
- 刷新按钮无限转圈(双层超时兜底 + 按钮单点控制)
- 手机号读取错页面(定位 workbuddy 页面)
- 总剩余口径统一(体验版 + 赠送)
- 历史快照乱序(时间升序)
- 浏览器缓存旧 JS、演示页跨域被拦
- 云同步下载后需手动刷新(改为自动刷新提示)
