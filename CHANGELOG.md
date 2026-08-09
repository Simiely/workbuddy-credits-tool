# CHANGELOG

## v1.4.51 (2026-08-09) · 修复墓碑 TTL 过期同步复活 P0(墓碑物理清理晚于上传)

### 修复(数据安全 P0,对齐 edge-multi-account-cookie v2.11.3 教训)
- **根因**:`/api/webdav/sync` 合并阶段原执行 `purgeOldTombstones()`(顺带清理过期墓碑)——**时机早于第二步上传**。墓碑 TTL 30 天过期后,同步时墓碑在"写入远端备份"前就被本地删除 → ① 合并时墓碑已删,`mergeAccountsSmart` 把远端旧账号当"无墓碑"导入 → **当次同步就复活**;② `exportAccounts()` 导出不含墓碑 → 远端备份被覆盖丢失删除标记 → **其他设备(本地有旧账号)同步时删除"复活"**(mock 复现:首次同步远端含墓碑 → 再次同步远端墓碑消失 → 设备 C 的 bob 复活)
- **修复**:`purgeOldTombstones()` 从合并阶段移除,**移到上传成功之后**——墓碑先随本次上传写入远端权威备份,确认传播后再清理本地过期墓碑,与"墓碑须存活足够久(传播删除)后被物理移除"语义一致
- 新增 `test/tombstone-ttl-bug.test.mjs`(3 断言:过期墓碑再同步远端标记不丢 + 设备 C 删除不复活)

### 验证
- 全量测试 12/12 通过(含新增墓碑 TTL 过期回归);既有 e2e S3 删除传播/S4 清空保护/S5 清空不写墓碑不回归

## v1.4.50 (2026-08-09) · 接入网站图标 favicon(打包标准 emoji 📉)

### 新增
- **网站图标**:wb-gui.html `<head>` 加内联 SVG data-URI favicon(`<svg><text>📉</text></svg>`,与 tool.json icon 一致)——**零文件、零后端改动**,子路径挂载自适应;PNG 文件方案已撤回

### 验证
- npm test 11/11 通过(191 断言);端到端 GET /favicon 页面 data-URI 正常解析

## v1.4.49 (2026-08-09) · 场景走查修复:同步/测试前端超时放宽

### 修复（场景走查发现）
- **根因**:一键同步/自动同步/保存并测试走前端 `api()` 默认 **15s 超时**;但同步链路=下载 2 文件(各 60s 超时)+合并+导出+上传 2 文件(各 60s 超时),DDNSTO 慢速穿透下易超 15s → 前端误报「请求超时」,而**后端 handler 不随前端断开取消**——用户看到"失败"但数据实际已同步,可能误导重复点击
- **修复**:`syncAct` 按动作放宽超时——`sync`=90s、`test`=30s(其余默认 15s)
- 影响:手动同步、自动同步(autoSync→syncAct('sync',true))、保存并测试(saveSyncCfg→syncAct('test',true))全部受益
- 验证:auto-up 14 断言 + 全量 11 文件通过;版本戳 v1.4.49


## v1.4.48 (2026-08-09) · 紧急修复:清空账号池误写墓碑致同步清空云端

### 事故(严重,已修复)
- **现象**:用户「清空本地数据」后点「一键同步」→ 远端(WebDAV)账号被覆盖为空
- **根因**:
  1. v1.4.46 的 `/api/clear-data`(清空账号池)对**全部账号写墓碑**——把"本地重置"误当成"全设备删除"
  2. 同步合并时墓碑判定:`mergeAccountsSmart` 见远端账号 `updatedAt ≤ deletedAt` 即从本地删除
  3. 清空后墓碑时间(now)必然 > 账号 updatedAt(历史时间) → **远端全部账号被删** → 本地空账号池 → 导出上传 → **云端被清空**
- **修复**:
  1. `/api/clear-data` 清空账号池**不再写墓碑**(本地重置不传播删除;仅 `/api/del` 单账号删除保留墓碑语义)
  2. `/api/webdav/sync` 加**清空保护**:拉取成功且远端有账号、但合并后本地账号池为空 → **拒绝上传**并报错(防墓碑误删/异常把云端清空)
- **数据恢复**:云端数据未被实际清空(NAS 上 wb-accounts.json 6 账号完整,系用户旧副本重新上传);本地误写墓碑已清理、账号已从云端恢复

### 验证
- e2e 新增 S4(清空保护:墓碑误删→同步报错、云端不丢)+ S5(clear-data 不写墓碑),**19/19 通过**
- 全量测试通过;版本戳 v1.4.48


## v1.4.47 (2026-08-09) · 修复备份剥离导致包级口径降级(今日已用被放大)

### 根因(v1.4.32 瘦身与 v1.4.43 包级口径的历史冲突,被同步功能暴露)
- **现象**:同一份数据,旧副本(v1.4.44,原始快照)今日已用 321/累计 4664;新副本(同步导入)今日 1169/累计 5655——数字被放大
- **根因链**:
  1. v1.4.32 备份瘦身:`exportLegacy` 导出 wb-history.json 时**只保留最新一组快照的 giftPackages**,历史快照全部剥离(上传 7.3s→0.4s 的代价)
  2. v1.4.43 包级口径 `consumeByPack` 需要**每天「首条+末条」快照的 giftPackages** 计算存活包净增量
  3. 同步/下载恢复后,历史快照(含当天首条)无 giftPackages → `consumeByPack` 首条无包 → **自动降级为增量口径 `consumeByPos`** → 失效包当天消耗被计入 → 今日已用/累计被放大(退回 v1.4.43 修掉的毛病)
- **实测证据**:8/8 全天 1020 条快照仅 24 条(1%)含 giftPackages,6 账号当天首条全被剥离;包级=降级=增量=1169(旧副本包级=321)

### 修复
- `exportLegacy`(history.js)剥离策略改为 **「每天保留首条+末条快照组完整(含 giftPackages),中间组剥离」**
  - `consumeByPack` 只读每天首末两条 → 恢复后口径不降级,数字回到包级
  - 体积几乎不变:每天 100+ 组快照 → 仅 2 组带包(备份仍百 KB 级)

### 数据恢复指引(已同步的剥离数据无法自愈)
1. 旧副本(原始 readings 完整)更新到本版本 → 手动「上传」一次(新剥离策略导出)
2. 其他设备「一键同步」→ 下载导入 → 派生自动回到包级口径
3. 也可直接整体替换 credits.db(从旧副本复制)

### 验证
- 新增 T6(webdav-sync.test.mjs,23 断言):失效包场景(包级 30 vs 增量 90)验证——导出后**首末组保留 giftPackages、中间组剥离、恢复库派生仍包级 30 不降级**
- 全量测试通过;版本戳 v1.4.47


## v1.4.46 (2026-08-08) · WebDAV 一键同步(上传/下载合并) + 删除墓碑传播

### 核心:上传+下载 → 一键同步(参考 edge-multi-account-cookie「先拉后传」方案)
- **新接口 `POST /api/webdav/sync`**：① 拉取远端 wb-accounts.json + wb-history.json(404=首次,跳过拉取) → ② 账号 **smart 合并**进本地(双向取最新)、历史**合并导入**(原有逻辑) → ③ 导出本地全量覆盖上传(远端固定保留最新 1 份)
- **拉取失败(非 404)即中止,不上传**——防本地旧数据覆盖远端新数据(与参考项目一致)
- 前端:「⬆️ 上传」「⬇️ 下载」两个动作/按钮**全部合并为「🔄 同步」**——操作条快捷 `[🔌][⬆️][⬇️]` → `[🔄]`,弹窗「保存配置+测试连接」→「💾 保存并测试」、「上传+下载」→「🔄 一键同步」;同步为无损合并,无需删除确认弹窗
- 旧 `/api/webdav/upload|download` 接口保留(向后兼容),前端不再调用

### 删除墓碑传播(v1.4.46,解决"删除不跨设备")
- **根因**:普通合并只能"双向取最新",无法表达"某个账号被删了"——远端没有它,合并时被当成"本地独有保留",旧备份会把已删账号复活
- **修复**:新表 `tombstones(uin, deletedAt)`;删除账号(/api/del)与清空账号池(/api/clear-data)写墓碑;`mergeAccountsSmart()` 合并时墓碑三态判定——
  - 远端账号 updatedAt ≤ deletedAt → 保持删除(不复活)
  - 远端新数据 > deletedAt → 复活导入
  - 本地账号 updatedAt ≤ deletedAt → 删除传播到本地;> deletedAt → 删除不生效(删后又更新过)
- 墓碑随 wb-accounts.json 备份传播(`exportLegacy` 导出带 tombstones,旧格式兼容);TTL 30 天 `purgeOldTombstones` 自动清理
- rename 补 `updatedAt`(防 smart 合并被远端旧显示名覆盖)

### 自动上传 → 自动同步
- 定时任务由"只上传"升级为"先拉合并再上传"(同步无损);文案「自动上传」→「自动同步」;守卫保留(WebDAV 配置被清空自动关开关)

### 验证
- 新增 `test/webdav-sync.test.mjs`(17 断言:smart 四态/墓碑三态/导出往返/TTL)+ `test/webdav-sync-e2e.test.mjs`(14 断言:mock WebDAV 端到端——首次同步/双向合并/墓碑跨设备不复活);auto-up 适配 autoSync
- 全量 **11 文件 190+ 断言全过**;版本戳 v1.4.46


## v1.4.45 (2026-08-08) · 前端 XSS 转义收口 + 冗余清理

### 安全（前端 innerHTML 注入收口）
- **根因**：账号「显示名/名称」可自定义，但 `acctName()` 返回值在 5 处渲染点直接拼接进 innerHTML **未转义**（`escAttr` 此前只在图表 data-n 使用）——含 `<img onerror>` 等 HTML 时会被浏览器解析执行（存储型 XSS 面，可破坏页面/注入脚本）
- **修复**：全部 innerHTML 注入点统一过 `escAttr()` 转义——
  - `renderCards`：卡片名 `nm` + 查询失败行错误信息
  - `renderDashTable`：手机卡片版（`.dname`）+ 桌面表格版（账号列）
  - `renderLines`（chart.js）：图例账号名（此前漏网）
  - `openDetail`（ops.js）：明细弹窗标题
  - `openRename`（ops.js）：改名输入框 value 属性
- **增强 `escAttr`**（state.js）：补 `>` 与 `'` 转义（原仅 `& " <`），属性上下文彻底防逃逸
- 验证：恶意 displayName 注入复现（`<img src=x onerror=alert(1)>`）→ 修复后渲染为纯文本转义实体；正常名称渲染不变

### 清理
- `wb-gui.mjs` `/api/credits`：移除冗余三元（两分支状态码恒为 200）

### 备注（排查结论，未改）
- **时区口径**：经 48 时刻 + 跨日临界快照验证——「后端容器(UTC) + 浏览器(+8)」形态下前端本地时区计算与后端 +8 口径**完全一致**（v1.4.29/30 已修后端即足够）；仅当浏览器自身时区 ≠ +8（跨时区访问）才需前端配合，本版不加（避免过度修改）
- **性能**：`deriveAll` 每账号 2 次 SQL（走 uin+ts 索引）实测 14.4ms/30 账号 × 18000 快照，批量全表扫描反而更慢（22.5ms）——保持现状
- **scheduler `sessionExpiresAt`**：非死代码（edge-collector 仍在采集写入，用于凭证临期加密采样），保留

- 验证：`npm test` 8 文件 120+ 断言全过；版本戳 v1.4.45（改前端必须 bump，浏览器缓存兜底）


## v1.4.44 (2026-08-06) · 二轮审计安全加固(daemon 鉴权 / CORS 同源 / admin 写面)

### 安全(高危)
- **edge-daemon `/eval` `/cmd` 加 token 鉴权**(edge-daemon.mjs):启动生成随机 token 落盘 `edge-daemon.token`(cwd),除 `/status` 外所有端点必须携带 `X-Daemon-Token`,否则 401——**浏览器跨域带自定义头会 preflight 失败,恶意网页无法再对已登录 WorkBuddy 页面执行任意 JS 窃取 cookie**。`daemon-client.js`/`wb-gui.mjs` 请求自动读 token 文件携带;平台浏览器桥模式(CAP_ENSURE_EP)由平台代管不受影响。实测:无/错 token 401、正确 token 放行、/status 开放
- **CORS `*` 收窄为同源**(wb-gui.mjs):跨源请求不再返回 `Access-Control-Allow-Origin`,浏览器同源策略拦截——防任意网页跨域读取本机 API(账号 cookie 等敏感数据)。实测跨源请求无 CORS 头
- **未鉴权写面挂 admin**:`/api/scheduler/run`(写库)与 `/api/open-workbuddy`(打开浏览器,副作用)设置密码后需 `X-Admin-Token`(未设置密码仍开放)

### 数据一致性
- `db.js` 加 `PRAGMA busy_timeout=5000`(GUI+CLI 双进程并发写不再立即 SQLITE_BUSY)
- `store.js saveAccounts` / `history.js appendSnapshot` 多步写包事务,失败回滚,避免半写状态

### 验证
- 8/8 测试全过;daemon 鉴权(无/错/对 token)、CORS 跨源拦截本地实测

## v1.4.43 (2026-08-06) · 消耗口径收口包级 + WebDAV 自动上传

- **fix(口径最终方案:包级净增量)**:「今日已用 342、累计才 38」的根因——增量口径(`consumeByPos`)在官方**包失效日**把今日已用算得比累计还大:今天消耗集中发生在当天从 active 转失效(status≠0)的包上,失效包的 used 不再计入累计净值,增量口径却永久保留它们的正增量(2026-08-06 实测:张妈妈今日 342、累计 38)
  - 新口径 `consumeByPack`:只统计**末快照仍 active 的包**的 used 增量;基线取**首快照全部包**(不过滤 status,防官方状态波动把存量包误判为"今天新增"而虚高);**首/末快照任一无包数据(采集异常/旧快照)降级 `consumeByPos`**;应用于 todayUsed/dailyUsed/gcDaySummaries
  - 效果:**今日已用必然 ≤ 累计已用**(用户直觉),历史日(8/5 包到期日)不再被抹成 0;真实库验证:坤坤今日 279≤累计 753、张妈妈 356≤1207,8/5 保留;小陈首快照无包数据(00:48 采集缺失)降级增量 → 今日 0(修复虚高 1789)
- **fix(累计已用语义修正)**:原「累计已用」取最新快照 used **净值**,包失效日远小于真实历史消耗(张妈妈今日 42、累计也 42,用户报"累计应该比今日大很多")。新增 `derived.consumed` = **历史每日消耗之和**(Σ dailyUsed.used,含固化摘要日),前端 hero/仪表盘卡/表格行/合计的「累计已用」统一改读它;真实库验证:张妈妈累计 899 > 今日 48、坤坤 493 > 19、爸爸 1027 > 88
- **fix(口径尝试后回滚,勿再改回)**:净值口径 `max(0, 末−首)` 曾让三数字自洽,但包到期日会把当日消耗算成 0(8/5 消耗 271 显示 0,用户报"5/6 日数据没了")→ 已废弃;包级口径是最终方案(真实 + 自洽)
- **feat**:WebDAV **自动上传**(登录/配置过云同步后,操作条出现「⏫ 自动上传 [N] 小时 开/关」控件):可填写间隔(默认 12 小时,1~168),到点自动把账号池+历史备份到 WebDAV;开关与间隔 localStorage 持久化,与「页面自动刷新」同构(前端定时,静默上传、失败必 toast)
- **ui**:操作条「自动刷新」文案统一为「页面自动刷新」(控件/toast/页脚三处),明确其语义=前端定时拉数据刷新界面(与后端 15 分钟固定采样频率无关)
- **ui**:「页面自动刷新」「自动上传」的开关由文字按钮改为 **iOS 风格滑块**(`.switch` 组件,勾选=开/绿色);移除 SSE 状态灯 `streamDot`(`setStreamStatus` 仅保留 `streamOk` 供刷新策略判断);新增正式脚本 `sea-build/gen-frontend.mjs` 重新生成前端内嵌
- **build**:`src/config.js` 支持 `WB_TOOLS_DIR` 环境变量覆盖数据目录(本地预览/测试用,生产不设即原行为);重新生成 `build/frontend-files.mjs`(本地源码版预览必须重新生成,否则前端走打包时的旧内嵌,新控件/文案不出现)
- **refactor(审计修复)**:①actions.js 两个间隔 change 监听器抽公共 `bindIntervalInput()`(core.js,autoMin/autoUpH 共用);②`autoUpload` 合并进 `syncAct("upload")` 单一路径,silent 语义改为"静默成功、失败必报";③autoUpload 加守卫:WebDAV 配置被清空时自动关闭开关并提示(防周期失败骚扰),`syncAct("clear")` 联动关闭;④`updateAdminBtn` 从 actions 归位 core(消除 core→actions 层级倒挂);⑤清理死码/过期注释(renderDash 告警条残留、state/actions 文件头);⑥`LS_FOLD` 常量归位 state.js;⑦HTML `.auto` 内联样式收敛为 `.auto-box` 类
- 验证:derive-consume 保持增量口径(9 项)+ auto-up 控件仿真测试扩至 14 项(含守卫),8/8 测试全过

## v1.4.42 (2026-08-06) · 平台版不自动弹浏览器 + 工具声明版本

- **fix**:平台版(file 采集)跑在 Windows 上时,启动/添加工具不再自动弹浏览器(仅桌面版 edge 采集自动打开)
- **feat**:tool.json 声明 `version`(供 tools-center 覆盖导入识别升级/降级并确认)与 `group: 监控`(平台单分类隐藏 tab)

## v1.4.41 (2026-08-06) · 趋势图点击柱子独显 / 点击空白恢复

- **点击柱子** → 每天只显示该账号的柱子(独显该柱数据);点击合计柱 → 每天只显示合计;再点同一柱子或**点击图表空白** → 恢复全部柱子一起显示
- 实现:barChart 支持 `soloKey` 参数(渲染时只保留选中账号/合计);柱子加 `data-key`;新增 `initChartSolo()` 点击事件委托(actions 启动段接线)
- 验证：7/7 回归测试 + 图表仿真(默认/solo=账号/solo=total 三种模式输出断言全过)

## v1.4.40 (2026-08-06) · 「打开网页」按钮(登录收录 cookie 一键直达)

- GUI「＋ 添加账号」旁新增 **「🌐 打开网页」** 按钮:一键经 edge-daemon 在调试 Edge 中打开 `workbuddy.cn` 登录页,登录后直接点「添加账号」收录 cookie(免手动开浏览器)
- 后端新增 `GET /api/open-workbuddy`(调 daemon `/newtab`,daemon 不可用时返回明确提示);前端 `openLoginPage()` 处理
- 实测:调用后在调试 Edge 中成功新开 `https://www.workbuddy.cn/` 标签页
- 验证：7/7 回归测试通过

## v1.4.39 (2026-08-06) · 全账号查询恢复 + 串号防护 + 签到基线修正 + SEA 单文件 exe

- **修复账号查询全部失败(400 Cookie Too Large)**:采集端 `Network.getAllCookies` → `Network.getCookies({urls})` 精确采集(治本);查询端新增 `sanitizeCookieHeader()`(剔除 KC_RESTART 等一次性令牌/广告跟踪 cookie + 同名去重 + 超 7KB 降级认证白名单),历史脏数据即时生效(治标)。详见 `docs/问题记录/账号查询400-CookieTooLarge.md`
- **修复账号串号**:`sanitizeCookieHeader` 同名去重"保留最后一份"在多会话混合的脏数据下把"爸爸"的凭证换成"鲁妈妈"会话;`src/compute/query.js` 新增 `assertOwner()` —— 接口返回 Uin ≠ 登记 Uin 即报错不落库(防再次污染);已修复数据并清理串号期 10 条污染快照。详见 `docs/问题记录/账号串号-清洗后爸爸查到鲁妈妈.md`
- **修复签到检测误判**:`detectSignIn` 基线由「今日首条快照」改为「昨日最后一条快照」(用户清晨签到早于首条快照时误判未签到;签到包只在签到当天新增);`gcDaySummaries` 同因修正,新增 `dayOfOffset()`。详见 `docs/问题记录/签到检测误判-首条快照晚于签到.md`
- **SEA 单文件 exe 支持**(免装 Node 双击即用):
  - `src/config.js` 路径双兼容(原生 ESM `import.meta.url` / SEA bundle `__filename`=exe 路径,数据目录=exe 所在目录)
  - `edge-daemon.mjs` 重构为 `createDaemonServer()` 可导入模块 + 独立运行入口;`wb-gui.mjs` 启动时内嵌 daemon(一个进程同时提供 GUI 8080 + 浏览器代理 8129)
  - `wb-gui.mjs` 前端文件内嵌(`build/frontend-files.mjs`,构建产物,已 gitignore),静态路由内存优先、磁盘回退
  - 构建脚本 `build-sea.mjs`(esbuild bundle → SEA blob → postject),产物 `WorkBuddy-Credits-Monitor.exe`(Windows 单文件,~83MB)
- **文档**:新增 `docs/新手使用手册.md`(面向新手的完整使用说明,含 exe 方式)
- 验证：7/7 回归测试通过；6/6 账号归属校验通过；签到 6/6 与快照签到包逐一吻合

## v1.4.38 (2026-08-05) · 前端结构优化（折叠/图表交互归位）

- 折叠逻辑 `toggleFold/applyFold` 从 state.js 归位 **core.js**（UI 基础设施），state.js 恢复纯状态/helper
- 图表 hover 委托从 actions.js 聚合归位 **chart.js**（`initChartTip()`，由启动段接线，副作用仍收敛 actions 启动段）
- tool.json icon `💎 → 📉`（与「积分消耗趋势」标题 emoji 同款）
- 验证：7/7 测试全过；服务端 curl 确认函数分布正确（toggleFold 仅 core、initChartTip 仅 chart、state 无折叠）

## v1.4.37 (2026-08-05) · 修复日期标签锚点（首尾组不居中的真根因）

- **根因**：X 轴日期标签旧逻辑首尾用 `text-anchor="start"/"end"`，x 是文字边缘而非中心 → 首尾日期视觉中心偏离柱子组中心 16px（中间组 middle 所以"4 日居中"）
- 修复：统一 `text-anchor="middle"` + x 夹取 `Math.max(L+16, Math.min(w-R-16, cx))` 防压 Y 轴/右缘
- 验证：node:vm 真实渲染 6+1 柱，三组文字中心 == 柱子组中心 **0.0px 偏差**

## v1.4.36 (2026-08-05) · 图表整列触发区（矮柱子好 hover）

- 每根账号柱/合计柱追加透明触发区（`fill="transparent"` 整列高=绘图区全高，宽=柱宽，data 与柱子一致）
- 鼠标移到柱子所在竖列任意高度都能触发悬浮浮层，矮柱子（2-3px）不再难 hover；透明不挡视觉与日期

## v1.4.35 (2026-08-05) · 柱子组居中 + 全版本戳兜底

- 合计柱取消右侧 `+bw` 间隔改为**紧贴**账号柱；柱子组总宽（账号+合计）在组内居中 → 日期标签（组中心）与柱子组中心对齐
- bw 公式分母改为含合计柱数（slotCount），语义清晰且 7 天窗口更紧凑
- 全版本戳 v1.4.34 → v1.4.35（URL 变，绕开浏览器强缓存——排查"改了没生效"的兜底手段）

## v1.4.34 (2026-08-05) · 面板标题点击折叠 + 图表字号微调

- 「📉 积分消耗趋势」「📋 账号总览」标题区域**点击即折叠/展开**（无按钮，`.phead.foldable` + `.folded + .pbody{display:none}`，状态存 localStorage `wb_fold` 刷新保持；标题内模式按钮不误触发）
- 图表辅助文字调小：「单位:积分/日」与 X 轴日期 10px → **8px**

## v1.4.33 (2026-08-05) · 每日签到检测（元数据推断，卡片标记）

- **需求**：账号每日签到领积分（第 1-6 天 100 分/天、第 7 天 1000 分），卡片标记"已签到"。
- **调研**：WorkBuddy 官方签到接口存在（`/billing/meter/check-gift-claimed`、`claim-gift`）但直连被 APISIX 网关 401 拦截；改用**纯元数据推断**（用户思路）——数据实证：签到 = 新增一个「到期日 = 领取日 + 1 自然月（对日）」的满额赠送包（8/5 签到 → 新增 9/5 到期的包；0813 08:50 包数 46→47、配额 +100 铁证）。
- **实现**：
  - derive 新增 `detectSignIn(firstPacks, lastPacks, todayKey)`：最新快照存在「今日首条没有 + cycleEndTime 对日 = 今天+1月」的包 = 已签到；对日匹配防昨天包误判、不要求满额防签到后消耗漏判、对比首条防已存在包误报
  - deriveAccount 输出 `signedInToday`（今日首条 vs 最新快照对比）
  - 前端卡片「今日消耗」行加签到徽标：✅ 已签到 / ⏰ 未签到
  - **固化摘要补签到字段**：day_summary 加 `signedIn` 列（含 ALTER 迁移），gcDaySummaries 固化时记录当天签到状态 → 历史签到可回查；备份镜像 summaries 带 signedIn
- **验证**：新增 test/signin-detect.test.mjs（7 断言：今天签/昨天不误判/已消耗仍识别/无包/首条已存在/固化 signedIn）；全量 **7 文件 120 断言全过**；真实数据 6 账号检测正确（5 签 1 未签）
- 版本戳 v1.4.33，服务已重启

## v1.4.32 (2026-08-05) · 历史数据固化 + 备份瘦身（存储与同步优化）

- **P1 备份瘦身**：
  - `wb-last-data.json`(最近刷新缓存,非账本数据)移出 WebDAV 备份 → 上传少 0.6MB
  - 删除死配置 `HISTORY_LIMIT=500`(import 未用)
- **P0 历史固化(规划落地)**：防止历史无限增长
  - 新表 `day_summary`(uin,day,used,startRemain,endRemain,PK uin+day) = dailyUsed 摘要持久化
  - `gcDaySummaries()`：把「T-2 及更早」每日快照压缩为摘要后清理明细；幂等(摘要已存在即跳过)；保留窗口=昨天+今天(供 todayUsed/dailyUsed 现算)；只处理有快照的账号(不依赖账号池)
  - scheduler 每轮 tick 按天节流自动执行一次(服务重启当天会再跑,幂等无害)
  - derive 双源读取：旧日从 day_summary 补齐,快照日期优先
- **P0 备份镜像含摘要**：`wb-history.json` 导出格式扩展为 `{snapshots(近期), summaries(全部摘要)}`；importLegacy 恢复时同步恢复 day_summary
  - **剥离历史快照的 giftPackages**(单条 6.5KB 体积大头,expiring 只读最新快照,仅最新一组保留) → 镜像 **3.8MB → 294KB(-92%)**,上传 7.3s → **0.4s**
- **P2 环境清理**：删除 10 个旧发布 zip,保留最新版(平台/Windows v1.4.30 + docker-update v1.4.28)
- **验证**：新增 test/gc-summary.test.mjs(12 断言:固化/幂等/派生不变/镜像恢复);全量 6 文件 **113 断言全过**;真实库固化 8/3(6 账号摘要)派生值不变、expiring 正常;云端上传实测 0.4s
- 版本戳 v1.4.32

## v1.4.31 (2026-08-05) · 消耗口径改为「已用正增量累加」,修复官方赠送包数据调整日今日已用归零

- 用户反馈:今日(8/5)部分账号明明有使用,但今日已用显示 0(其余人「刷新不出来」)。
- **根因**:官方今天(8/5)对多个账号的赠送包数据做了调整——包消失/重置导致「已用」回退(如 0813: 296→0、6627: 92→0),「剩余」漂移甚至增加(0813 首条 3250→最新 3280)。旧口径「今日首条剩余 − 当前剩余」被干扰 → 算出 0 或负值(钳 0)。
- **修复(derive.js)**:新增 `consumeByPos(arr)`——对按时间排序的快照序列,累计「已用」正增量(正常消耗累加,包重置导致的已用回退时 prev 同步到回退点、重新从低值累计)。应用于 todayUsed 与 dailyUsed/series(每日趋势),口径统一。
- **同类漏洞审查(本轮)**:
  - `consumed`(累计消耗)是唯一剩余「剩余差」口径(`first.totalRemain - last.totalRemain`),官方包变更时同样失真,且**前端/CLI/测试零消费**(死字段)→ 已删除,派生层只保留被消费字段
  - 审查确认安全:前端明细表用 `dailyUsed.used`(新口径)、hero 环比昨日用新口径、expiring1/2/3/7d 与 giftBuckets 基于最新快照 giftPackages(当前视角,包变更后自动反映新状态)、采样/调度/同步/导入链路无类似问题
  - 遗留(非漏洞):官方数据反复震荡时正增量口径仍偏高(如坤坤 125),属数据源本质限制
- **验证**:新增 test/derive-consume.test.mjs(9 断言:正常消耗=60/包重置=66/持平不变/昨日今日序列/回退无负消耗);全量 5 文件 **101 断言全过**。真实数据:张妈妈 0→77、鲁妈妈 0→74、坤坤 52→125(官方震荡导致略偏高,数据源本身问题)。
- 版本戳 v1.4.31,服务已重启。

- 用户反馈:页面左上角(header「积分指挥中心」下)时间显示 `8/4 16:47`,实际本地是 `8/5 00:47`。
- **根因**:与 v1.4.29 同源——`/api/all` 的 `fetchedAt` 用 `new Date().toLocaleString("zh-CN")` 依赖进程时区,Docker 容器(UTC)下显示 UTC 时刻。
- **修复**:wb-gui.mjs 与 src/present/render.js 新增固定中国时区(+8)的 `cnNow()`,替换全部依赖进程时区的时间显示(Web UI fetchedAt 2 处 + CLI 渲染 3 处),与 derive 自然日口径一致。
- 验证:模拟 `TZ=UTC` 运行 `cnNow()` 输出 `2026/08/05 00:49:29` 与本机一致;实跑 `/api/all` fetchedAt 正确。92 断言全过。

## v1.4.29 (2026-08-05) · 派生自然日固定中国时区(+8),修复容器 UTC 错位

- **根因**:docker 容器(node:alpine)默认 UTC,而 derive 的自然日计算用"进程本地时区" → 容器里 8/3 数据被算成 8/2(趋势缺 8/3)、今日已用基线取到 8/4 晚间(800 多)。edge 桌面(Windows GMT+8)正常,所以"edge 对、docker 错"。
- **修复**:derive.js 的 `dayKeyOf`/`startOfToday`/`deriveGiftExpiry`(fmtD/dayKey/limit)全部改为**固定 UTC+8 口径**(cnWall/cnDay0 辅助),与部署环境时区无关;容器/桌面结果一致。
- 双保险:docker-compose.yml、Dockerfile 加 `TZ=Asia/Shanghai`。
- 验证:模拟容器 `TZ=UTC` 跑 derive → dailyUsed 正确含 8/3、todayUsed 7(原 800+)、expiring3d 正常。92 断言全过(沙箱 +8 行为不变)。
- 版本戳 v1.4.29;服务已重启。

## v1.4.28 (2026-08-05) · WebDAV 网络超时自动重试 + 大文件超时放宽

- 用户反馈云同步不稳定、间歇超时。实测 DDNSTO 连接 86~209ms、上传 3.16MB(wb-history.json,快照含赠送包明细导致 3.6MB)仅 7.3s——超时根因是 15s 临界 + 穿透抖动。
- 修复:`req()` 对网络超时/连接错误退避重试 2 次(0.8s/1.6s);上传/下载大文件超时放宽到 60s(小请求仍 20s)。叠加 423 重试,穿透抖动+大文件不再失败。
- 附:排查中发现 wb-sync.json 的 url 被清空(00:24),上传报 URL 解析错误——配置地址需重新填写。
- 92 断言全过;服务已重启。

## v1.4.27 (2026-08-05) · 图例区加「合计」标签 + 合计柱去文字

- 趋势图图例区**最右侧新增「合计」标签**(灰色,与合计柱同色;点击隐藏/显示合计柱,交互与账号图例一致)。
- 合计柱顶部**去掉「合计」二字,只保留数字**(说明由图例承担,柱上不重复)。
- TOTAL_COLOR 提升为 chart.js 顶层常量(barChart 与 renderLines 共用)。
- 测试 T10 更新(图例含「合计」、柱上无「合计」文字);92 断言全过。纯前端无需重启。

## v1.4.26 (2026-08-05) · WebDAV 上传 423 锁重试

- 用户反馈「上传 wb-history.json 失败(HTTP 423)」。探测确认:DDNSTO 穿透的 WebDAV 服务器**无持久锁**,423 是瞬时锁(文件被其他程序/同步任务短暂占用)。
- 修复:`uploadFile` 对 423 做**退避重试 3 次**(1.2s/2.4s),仍失败时提示"文件被服务器锁定,请稍后重试"。
- 恢复:探测期间意外用 probe 覆盖了云端 wb-history.json,已用本地完整版(338 条快照,8/3×292 + 8/4×46)重新上传恢复。
- 91 断言全过;服务已重启(后端改动)。

## v1.4.25 (2026-08-05) · 每日窗口改为「数据对齐」+ 上限 7 天

- 窗口语义调整:不再"以今天为中心对称",改为**从最早数据日向右延伸**(2 天数据 → 8/3 8/4 8/5,折线有伸展空间);数据超过上限取**最近 span 天**(终点 = 最晚数据日)。
- 上限 10 → **7 天**;跨度仍夹在 [3,7]。
- 修复时区错位:daySet 日期键改用本地自然日(getFullYear/Month/Date),原 toISOString().slice(0,10) 是 UTC 日期会错位一天。
- 测试 T1(1 天→今天/明天/后天)、T5(15 天→最近 7 天=今天-6~今天)重写;91 断言全过。纯前端无需重启。

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
