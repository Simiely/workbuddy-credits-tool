# Changelog

本文件记录 trae-credits-tool 的口径/架构/测试相关变更。遵循 Keep a Changelog 风格，语义化版本。

## [1.12.12] - 2026-11-06（补签按钮 + 设备号冲突修复 + 假成功修正）

### Added

- **顶栏「补签未签」按钮**：`POST /api/checkin/run {"onlyMissing":true}` 只给今日未签到的账号补签，已签到的自动跳过；异步启动 + 轮询 `/api/checkin/status`，完成后自动刷新页面。
- 新增 `src/compute/device-pool.js`：扫描全部 TRAE 登录态槽，收集已登记的 `icube-dc` 设备号，按账号稳定分配互不冲突的 `x-device-id`。
- 补签历史新增 `skipped`（跳过的已签账号数），`state.lastResult` 同步。

### Fixed

- 🔴 **多账号共用设备号 → 签到被拒且被误报成功**。TRAE `checkin_credits/claim` 按 `x-device-id` 做「每设备每日一次」校验；从同一台机器导出的多个账号共用同一个 `icube-dc`，第二个起返回 `code 9095 当前设备今日已经签到`。现在撞 9095 时依次换用其它**真实已登记**的设备号重试（伪造 / 空设备号会返回 9074 / 9004，见 v1.9.3 A/B 实测）。2026-11-06 实测：六月 / 闻斌trae 换号后立即 `code 0 success`，状态查询转为 `checked_in:true`。
- 🔴 **业务错误被当成成功**：`fetchTraeCheckin` 原先只把 `code 9074` 判为失败，9095 等一律 `ok:true`，导致 `checkin-history` 出现假 `added`、页面仍显示未签。现在只有 `code===0`（或无 code 字段）才算成功，其余明确报错并列为 `failed`。
- **补签按钮脚本 404**：`trae-gui.mjs` 的静态 JS 采用显式白名单（原先 7 个），新增的 `wb-gui.checkin.js` 未登记，浏览器请求返回 404、按钮点击无响应。白名单扩为 8 个并放行该文件；部署后 `/wb-gui.checkin.js?v=v1.12.12` 返回 200，实测 `POST /api/checkin/run {"onlyMissing":true}` → `skipped=15 / added=0 / failed=0`（全部已签账号被跳过，无重复领取）。

## [1.9.4] - 2026-10-25（账号总览不再显示「↺N 服务端回收」标记）

### Changed

- **账号总览的账号名后面不再挂 `↺N` 回收标记** —— 手机卡片版与桌面表格两处都去掉
  （用户 2026-10-25：「账号总览名称后面不显示服务端回收的信息」）。
  标记本身不删：它是"这个号的积分包被服务端回收过"的唯一可见线索，只是**每行都挂一枚**太吵；
  改到顶部账号卡片网格继续显示（一个号一张卡），悬停 title 仍能看到具体回收量。
- 版本号 `1.9.3 → 1.9.4`：`package.json`（单一真源）与 `tool.json` 同步；
  `wb-gui.html` 里 7 个 `?v=v1.9.x` 缓存击穿参数一并更新，否则浏览器会继续吃旧 JS。

## [1.9.3] - 2026-10-08（4 个真缺陷：deviceId 口径 / attempts 不复位 / 手动签到 502 / 大响应超时）

### Fixed

- 🔴 **`x-device-id` 用错设备号 → TRAE 签到全挂（9074）**。
  `readAuthFromStorage` 原优先取 `telemetry.devDeviceId`（**机器级**遥测 id，本机 6 槽里
  4 个共用同一个值 `afe8d8f7-…`）。2026-10-08 同秒 A/B 实测：同一 token 同一账号，
  `devDeviceId` → `9074 当前参与用户太多`；换 `iCubeAuthInfo://icube-dc:<id>` → `code 0 success`。
  现改为**优先取槽内 `iCubeAuthInfo://icube-dc:<id>`**（登录时服务端登记的设备号，每账号唯一），
  `devDeviceId/machineId/sqmId` 降为兜底。

- 🔴 **`attempts` 跨天不复位 → 失败自动重试永久失效**。
  `runDailyCheckin` 里 `state.attemptsDay = result.day;` 写在三元比较**之前**，条件恒真 →
  `attempts` 成为**终身计数**，`attempts >= 6` 从第 6 次起永远成立 → 2026-10-03 起
  每天首次失败就写 `lastDate` 放弃。与历史逐项吻合（10-01/10-02 各 2 轮且重试成功、
  10-03 起每天只剩 1 轮、现值 attempts=11 也对上）。现在显式按天归零。

- 🔴 **手动签到必然 502**：`POST /api/checkin/run` 同步实现，一次签到最坏 =
  6 个 TRAE 串行 × 内层 6 次退避（12s+抖动）≈ 数分钟，而 tools-center 反代有
  **60s 上游超时**（2026-10-08 实测 502 / 60.014s），且被中断的那次在
  `checkin-history.json` 里**没有记录**。改为**异步启动**（202 + 轮询 status），
  `state.inFlight` 防并发双跑；`dryRun`（只查不领）保持同步。

### Changed

- **重试节奏重构**：`MAX_RETRY_PER_DAY` 6 → **12**，新增 `RETRY_GAP_MIN = 30`
  （两次尝试至少隔 30 分钟）—— 9074 高峰限流往往持续 1 小时以上，旧的 6 次/天
  只覆盖 30 分钟窗口。节奏同时进 `shouldRunCheckinNow` 门闸（不再只靠计数）。
- **WB 读超时单独放宽**：新增 `WB_FETCH_TIMEOUT_MS = 20000`（`get-user-resource`
  单账号返回几十 KB；TRAE 仍 8s）。2026-10-08 实测 NAS 抖动时 8s 不够用，
  而同主机同路径 PROPFIND 0.1s 返回、`daily-checkin` 小响应正常。
- **WB 采集冷却退避**：连续超时后按 2^n 分钟退避（2/4/8/16/30 分钟封顶，
  `wbNextCooldownMs`），冷却期内快速跳过，任一成功即复位 —— 避免抖动期
  每 5 分钟 × 6 账号硬撞同一个不响应的端点。

### Notes

- `92 passed / 0 failed`（`node --test`，原 89，+3：deviceId 口径、attempts 复位回归、
  冷却节奏、间隔门闸；test/wb.net.test.mjs 新增 3 项）。
- A/B 证据：同一秒内 `devDeviceId` 9074 ×2、`icube-dc` success、空 device id → 9004
  （说明该头确实参与校验，排除"随机限流"）。
- 前一天（10-01~10-07）的签到"部分失败"由此加剧：失败账号在当天内再无重试机会。

## [1.9.2] - 2026-09-30（口径切换日角标 —— 让趋势图自己解释那根"矮柱子"）

v1.9.0/v1.9.1 上线当天用户报「今日用了很多，趋势图没体现」。定性：**预期行为** ——
当天读数跨越 used 语义版本（26 条 v1 + 4 条 v2），交界差分被断账守卫丢弃，切换前的
消耗没有新口径基准可减（旧读数的 remain 同样是冻结值），数学上不可回填；小黄的
307.44 恰好证明 v2→v2 差分链路正常。唯一的永久代价是 09-30 当天的趋势条不完整，
但**界面没有任何提示**，日后翻历史会误读成"那天没用"。

修（两处，判定同源）：
1. **derive.js**：三态格式判定抽为导出的 `usedFmtOf()`（`consumeByUsed` 与标记共用
   一份，防止"标了切换日却没断账"的口径漂移）；按日聚合时检测该日读数是否跨 fmt，
   是则 `series` 点带 `b:1`、`dailyUsed` 行带 `schemeBoundary:1`。
2. **wb-gui.chart.js**：切换日整组柱（含合计柱）半透明 + 琥珀虚线描边，组顶 ⚠ 角标，
   左上图注「⚠=口径切换日,当日消耗不完整」，悬浮浮层追加一行说明。

+1 全链路回归（交界日标记 / 非交界日不误标 / 断账仍生效）。全量 57 测试通过。
发版对齐：package.json / tool.json / wb-gui.html 缓存串 / wb-gui.render.js 页脚 → 1.9.2。

## [1.9.1] - 2026-09-30（部署日交界兜底禁用 —— v1.9.0 发布前自查追补）

v1.9.0 发布前自查消费点全景时发现的边界：`deriveAccount` 在「今日仅 1 条快照」时走
「今日首条 − 昨日末条」差分兜底，**没有查 used 语义版本** —— 部署当天 WB 账号的
今日首条 v2 快照与昨日末条 v1 快照的差是**基准差不是消耗**，会在界面闪现数百分的
假今日消耗（下个采样周期第二条 v2 快照落库后自愈，但错的终究是错的）。

修：跨 used 语义版本（v1↔v2）时禁用兜底，宁可显示 0 —— 与 `consumeByUsed` 的
格式交界规则同一条纪律。+2 全链路回归（交界禁用生效 / 同版本兜底不误伤），
全量 56 测试通过（原 40 + 新 16）。

## [1.9.0] - 2026-09-30（WB 读数换根基：按 CapacityType 声明取值 + 资源身份阶段 0）

用户报「本地服务读不到今天的消耗」。排查（90 秒差分取证）定性为**读数字段选错**：
WorkBuddy 的周期额度包（CapacityType=4）普通 `Capacity*` 字段是**冻结值**，真实用量只在
`CycleCapacity*` 上 —— 而解析代码读的是前者 → 今日消耗恒 0。此前试过 max/min 钳位，是止血；
本次按 2026-09-30 对 192 个包的全量核对（type 1/4 = 186/6，与"字段是否冻结"完全对应）换根基。

**五件事：**

1. **字段选取声明化，口径只写一份**：新增 `model.pickWbPackFields()` —— type=4 读
   `Cycle*`、其余读 `Capacity*`，两族都 **Precise 优先**（整数版各自截断，三元组对不上账：
   500/357/142 vs 500/353.47/146.53）。`wb.parseWbResources` 与 `model.buildWbSnapshotEntry`
   此前各写一份"整数优先"且同错（架构审计点名的双写断裂），现共用一份。
2. **总剩余不再拿 TotalDosage 当权威**：它对周期额度包给冻结整包容量（体验版恒 500），
   改为 Σ各包实时余量，无包时才回退。
3. **资源身份阶段 0（纯增量）**：`giftPackages[]` 开始携带 `rid / cycleId / kind / startAt`
   （WB: ResourceId+CycleStartTime；TRAE: entitlement_id+start_time，实测 311/311 同账号内
   唯一、跨抓取稳定）。为身份记账引擎铺路 —— 上游一直在给身份，此前落库时扔掉了。
4. **used 语义版本化（scheme:2）**：WB 换读数后与历史 used 基准整体不同 → 快照打 `scheme:2`，
   `consumeByUsed` / `ledgerFromSnapshots` 的格式判定升为三态（legacy / unified / unified-v2），
   交界断账一次 —— 不把基准跳变计成消耗（本项目此坑反复踩过）。TRAE 读数未动、不打标记。
5. **测试与文档纠偏**：新增跨引擎不变量守门（同一批快照 consumeByUsed ≡ ledgerFromSnapshots，
   7 条）与换根基专项（7 条）；修复 `derive.test.mjs` 的**测试日期腐烂**（硬编码 2026-10-01
   在 09-30 恰落 expiring1d 窗口 → 改相对日期）；纠正 `db.js` daily_ledger 注释
   （实现是"已用差分"，注释写成"剩余下降"且与 ledger.js 头注释矛盾）。

全量 54 测试通过（原 40 + 新 14）。发版对齐：package.json / tool.json / wb-gui.html 缓存串 /
wb-gui.render.js 页脚 → 1.9.0。

## [1.8.3] - 2026-09-28（补 30 天到期窗口 + 明细「近30天过期」单位纠正）

用户报「小黄trae 明明有很多分要过期，为什么没有计算，算漏了项吗」。**数据一分没漏**
（28 个包余量之和 2987.06 == 服务端 giftRemain，零残差），漏的是**窗口**：

TRAE 签到包有效期就是 30 天，而积分**先到期的先被消耗** → 1~7 天内的包通常早已用尽
（余量 0、不进统计）。于是到期压力天然全部落在 **8~30 天**这一段，而界面上只有
1/2/3/7 天四档 → 小黄trae 显示 0/0/0/0（实际 **30 天内 2843.22 分**待作废）、
爸爸trae 显示 0/0/0/0（实际 **4672.71 分**）。全账号合计：7 天内 12553.44 分 vs
**30 天内 47990.37 分** —— 用户看到的"0"与真实到期压力差了一个量级。

三处修：
1. **新增 `expiring30d`**（与其它窗口同口径：只算"会作废的分"，与 expiryTier 的
   `SCAN_MAX` 同界）；卡片、合计行、桌面表格各补一列/一格。
2. **明细弹窗「📅 近30天过期」原显示的是 `expCount`（已失效包的个数）** —— 单位错位，
   用户看到「近30天过期 8」而实际有 2843 分要作废。现改为金额（`expiring30d`），
   `expCount` 移到积分包标题：「28 个包 · 其中已失效 8 个」。
3. **明细「状态」列原恒显示"有效"**：判据写成 `p.status === 0 ? "有效" : "失效"`，而落库时
   status 已按 TRAE 语义归一化为 0（见 model.js）→ 用尽/作废的包也标"有效"。改为读新增的
   纯函数 `packStateOf()`（`ok`/`used`/`stale`），由派生层随 `giftPacks[].state` 带出，
   UI 不再自己判。

+4 测试（69 passed / 0 failed，原 65）：30 天窗口覆盖 8~30 天（用户场景的最小复现）、
30 天窗口不越界（第 31 天不计）、`packStateOf` 三态且不受 status 影响、**接口级防断链**
（真写一条含 giftPackages 的 reading，断言 `deriveAccount` 确实带出 `expiring30d` 与
`giftPacks[].state` —— 纯函数对 ≠ 接了线，UI 已经断链过一次）。
变异 4 组全红：30 天窗口退回 7 天 / packStateOf 改回按 status 判 / 派生不带 state /
窗口下界失效（把已作废的余量也算进来）。

附：柱图「到期明细」的 1 天/3 天柱副标本就注明「今+明」，窗口与标注自洽；卡片标签
「近N天过期」的字面为 N 天、实现为"到今天+N 天末"（含 N+1 个自然日），属既有口径，
本次不动，仅在卡片新增 30 天档。

## [1.8.2] - 2026-09-28（过期排序修复：已耗尽的空包不再污染紧迫度）

用户报「现在过期排序不对」。根因与 v1.8.1 连着的同一片地基：**「会作废的包」判定漏了"余量 > 0"**
这一半条件 —— 只有"有到期时间"就被算进紧迫度，于是**已耗尽的旧包**（剩 0.00）也能把账号的
紧迫度层拉到最前。

其实测复现（2026-09-28 线上快照）：小黄trae 28 个包里前 6 个余量都是 0，其中「签到奖励 1」
剩 0.00 恰好今天到期 → `expiryTier = {tier:0, amount:0}`，于是一个**一分都不会作废**的账号
被排到「明天有 744 分要作废」的小陈前面；爸爸trae、坤坤trae 等 6 个账号同病（tier 被提前、
amount 恒 0）。同一批数据里凡 `amount === 0` 的层，都是空包造出来的假层。

修复（口径唯一化，三处共用同一个 clean）：
- `clean` 从「有到期时间」收紧为「**有到期时间 且 余量 > EPS(0.005)**」；
  `expiring1d/2d/3d/7d`、`giftBuckets`（周桶）、`expiryTier` 全部随之受益 —— 空包既不占周桶、
  也不再把紧迫度层提前。**刻意不设金额门槛**：0.5 分也是会作废的分，只剔"余量为 0"这一类。
- 修复后实测排序：小黄trae 从第 1 位（tier 0 / amount 0）落到第 11 位（tier 10 / amount 143.22），
  有量到期的账号回到前面；爸爸trae tier 2→15、坤坤trae tier 2→3 且 amount 0→2675。

+4 测试（65 passed / 0 failed，原 61）：空包不污染紧迫度（tier 与 amount 都钉住）、全空包 →
tier=∞ 而非最紧迫、小额（0.5）仍参与、窗口合计不受空包影响；变异 3 组全红（去掉余量过滤 /
给余量设金额门槛 / 紧迫度漏掉今天到期）。其中一条原先设计的变异「去掉到期时间条件」实测
为**等价变异**（三处各自还会再判一次 parse，去掉不影响行为），已换成真正会改行为的变异。

已知遗留（本次未动，待口径确认）：
- `expiring1d` 窗口实为"今天+明天"、`expiring2d` 实为"今天+明天+后天"，比标签「近2天过期」
  多含一个自然日（`expiringSum(n)` 覆盖 n+1 个自然日）。
- 明细弹窗「近30天过期」标的是 `expCount`（已失效包**个数**），既非金额也不设 30 天界。

## [1.8.1] - 2026-09-28（过期统计改用 TRAE 自己的语义：status 不再当"是否有效"）

### Fixed

- **TRAE 的"即将过期 / 过期积分"严重漏算**（用户报「traework 的过期积分计算非常不准确」）。
  根因：`deriveGiftExpiry` 用 `status === 0` 当"包是否有效"的判据 —— 那是 **WorkBuddy 的语义**
  （`wb.js`：Status=0 且周期未结束才算有效包）。而 TRAE 的 `status` 是**另一套枚举**：实测
  status=0 与 status=1 的包都持有余额，且「Σ各包 capacityRemain == 服务端 giftRemain」
  逐账号**零残差**（2026-09-28 六账号实测）→ **status 与"是否有效"无关**。
  修前把 TRAE 的签到包（全部 status=1）整批排除在过期统计之外：

  | 账号 | 服务端剩余 | 全部包 Σ | 只算 status=0 | 漏算 |
  |---|---|---|---|---|
  | 小黄trae | 2993.22 | 2993.22 | **0.00** | 100% |
  | 坤坤trae | 4225.00 | 4225.00 | 2475.00 | 41% |
  | 爸爸trae | 4822.71 | 4822.71 | 3172.71 | 34% |

  修复后（同一时刻实测，与"以 `endTimeS` 独立复算"逐账号零残差）：
  坤坤trae 7 天内到期 **0 → 2875**、张妈妈trae 3 天内 **0 → 500**、鲁妈妈trae **0 → 500**。
- **落库时归一化 status**（`model.js`）：TRAE 分支统一写 `status: 0`（这些包已过 `isCreditable`
  过滤、都是有效可耗包），服务端原值另存 `statusRaw` 供排查。
- **`parseEntitlementData` 的有效/过期判据同样去掉 status**：改为只看 `end_time`
  （`active = 未结束`）。否则 `expCount`（"含过期 N"）虚高、`activeRemain` 偏小。
- **到期时刻优先用服务端秒时间戳**：新增 `packEndOf()`（`endTimeS` 优先，仅在缺失时回退解析
  `cycleEndTime` 字符串）。字符串**无时区标记**，解析结果取决于运行环境 TZ（容器设了
  Asia/Shanghai 才对得上）—— 用秒时间戳可彻底摆脱这个隐含依赖。
- **`sum()` 同时支持"字段名 / 取值函数"**：定义只支持字段名，而 `parseEntitlementData` 传的是
  函数 → `a[fn]` 恒为 undefined、兜底分支被静默算成 0（核对过期口径时发现）。

### Verified

- `node --test` **61 passed / 0 failed**（+1：`packEndOf` 秒优先 + `buildSnapshotEntry`
  status 归一化；改写 1 条基于 WB 语义的旧断言「非法包不过期不计入」）。
- 端到端核对：`deriveGiftExpiry` 输出与"以 endTimeS 独立复算"逐账号零残差。
- 变异验证 3 组全红：过期过滤加回 status / 不优先用秒时间戳 / status 直传不归一化。

## [1.8.0] - 2026-09-28（累计口径重写：账本模型取代「锚点 + 世代判定」）

### Why（用户诉求：不要补丁打补丁，站到根因）

用户连续两次看到累计消耗跳水（「昨天还是 2w 多，今天又变成 1.6w 多」）。取证结论：
**这不是实现 bug，是数据模型的原理缺陷** —— v1.7.2/v1.7.3 两次补丁都在同一块地基上叠护栏。

- 实测两条误判记录（`epoch_start`）：
  - 小陈trae：`cum-drop ref=8247.4 drop=4600`（09-24）→ 累计 8247.4 → **3852.56**
  - 小黄trae：`cum-drop ref=6306.78 drop=4200 explained=1506.78 unexplained=2693.22`（09-27 16:00 UTC）
    → 累计 6306.78 → **2106.78**（Σ 1.94w → 1.67w，正是用户看到的那次）
- 根因链：服务端回收积分包 → `cum`（**现存**包的已用之和）回落，而回落的是**已经真实消耗过**
  的量 → 锚点 `base`（历史累计，只升不降）与 `cum` 出现落差 → 判定逻辑把它当「账号重建」证据。
- **为什么补不掉**：「包被回收」与「账号被重建」在 cum 曲线上**原理不可分**（只要回收的包里
  有用过的余额，两者同形），而回收是常态（旧注释自己写着"实测下降 11 次"）。判定式里还有
  一处结构性缺陷：锚点没存 size，只能拿**锚点的 cum 当 size 下界**
  （`floorSize = prev.size == null ? prev.cum : prev.size`）→ 解释项被系统性低估 →
  任何一笔回收都会被算成"未解释回退"→ 越过阈值即判重建 → 抛弃锚点 + 抛弃世代前全部日用量。

### Changed

- **新增 `daily_ledger` 表 + `src/compute/ledger.js`**：按天记账，口径只用「已用」的正增量，
  并给每笔变动分类：
  - `Δused > 0` → `used`（消耗，计入累计，只增）
  - `Δused < 0` → `recycled`（服务端回收积分包：该包的已用计数一起消失）
  - `Δsize > 0` → `added`（到手：签到 / 礼包 / 新包）
  - legacy ↔ unified **格式交界不记账**（两套 used 语义不同，交界处基准整体跳变）
  > 第一版设计用「剩余下降」当消耗，被回归测试当场否掉：包被收回时**包里未用完的余额**
  > 也会消失（Δremain < 0），于是"作废"会被误记成"消耗"。只有 used 视角不会犯这个错。
- **累计口径 = `base`（迁移前历史，只写一次）+ Σ账本(day<今天).used**，与观测下界取大
  （两者都只增，取大安全且单调）。`base` **不再逐日并入** —— 那段"并入时重复/漏加"的边界
  bug（v1.7.1 修过一次）随之消失。
- **整体删除世代判定**：`src/compute/epoch.js`、`loadEpochStart/setEpochStart/cumSeries/maxCumSince`
  与 `/api/epoch/detect`、`/api/epoch/status` 路由；采样链路（`sample.js`）不再做任何"猜重建"的动作。
  新排查入口 **`GET /api/ledger/status`**（每账号 base/used/added/recycled + 最近留痕）。
  `epoch_start` 表保留仅供追溯，代码不再读写。
- **云镜像（`trae-history.json`）补齐 `baselines` + `ledger`**：此前只同步 snapshots/summaries，
  云恢复后起点与账本会丢 → 累计归零/错位。
- **前端世代标记 `↻MM-DD` → 回收标记 `↺N`**（`wb-gui.render.js`，函数改名 `ledgerBadge`）：
  回收从此是可见的账目，而不是导致累计重置的理由。
- 派生视图新增 `ledger: {base, used, added, recycled, days}`；`epoch` 字段移除。

### 迁移（`tools/migrate-ledger.mjs`，幂等可重跑）

```bash
TRAE_TOOLS_DIR=/path/to/instance node tools/migrate-ledger.mjs [--dry]
```
保留 `consumed_baseline` 现有值作为**账本起点**（它就是迁移前的历史累计，含"被回收的包当时
已用掉的部分"——符合用户口径"用掉就算"），再从明细回填起点日之后的账本行。

### Verified

- 本地以 NAS 备份库（含 WAL）实跑：Σ 累计 **16737.63 → 25293.51**（小黄trae 6306.78、
  小陈trae 8252.56 —— 两次被误砍的历史都回来了），与端到端 `deriveAll` 输出逐账号一致。
- `node --test` **60 passed / 0 failed**（原 52，删 4 个 epoch 用例 + 新增 10 个账本用例）。
  新增测试含两条守护断言：**「包回收后 consumed 不回退」**、**「base 远超瞬时已用时累计仍按锚点」**
  （就是小黄trae 现场：6306.78 vs 2106.78）。
- 变异验证 4 组全红：回收被当成消耗 / 格式交界不跳过 / 忽略锚点 base / gc 不给昨天落账。

## [1.7.3] - 2026-09-24（判定吸收「入账/积分包变动」：>1000 的大额进入不再被误判为账号重建）

### Fixed

- **大额入账 / 积分包消失被误判为账号重建**（用户实测提示：全新账号会有 >1000 的进入）。
  旧判据只看「累计跌了多少」，但累计的下跌有**两种**成因，量级上分不开：
  - **积分包消失/轮换** → 该包的已用计数一起消失，`size` 与 `cum` **等量同掉**
    （实测小陈TRAE 09-23T16:20：Δsize −200 / Δcum −200）→ 是账目现象，不是账号重建；
  - **入账**（新包 / 新用户礼包，**>1000 很常见**）→ `size` 上涨、`cum` 不动
    → 本身不产生回退，但会「抬高」后续比较的基准，掩盖掉早先包消失的证据。
  旧公式（最高水位 vs 最新快照）因此会误判 → 错误开新世代 → **累计少算**。

### Changed

- **判据改为「未解释回退」**：`unexplained = Δcum − min(Δcum, Δsize 减少量)`。
  - 包消失 → Δsize 与 Δcum 等量同掉 → 0，可解释；
  - 入账 → 不产生回退；
  - 账号重建 → Δcum 远大于 Δsize 减少量 → 剩余部分才是真凭据。
  不变式依据：任何快照都满足 `cum ≤ size`（`cum = Σ(size−remain)`），故参照累计本身即可当
  `size` 的下界 —— 锚点/删除留痕没有 size 时靠这条兜底，方向偏保守（宁可判重建）。
- **必须逐对相邻快照判定，不能拿「最高水位 vs 最新快照」比**（首版公式，被端到端场景 F 当场抓到）：
  序列 `5000/6000 → 3000/4000 → 3000/9000` 里包消失与入账是**先后两步**，混在一起看时
  后一步的入账把 size 抬高，解释项归零 → 误判成重建。改为 `worstUnexplainedStep` 取
  「未解释回退」最大的那一步（平手时取跌幅更大的一步，便于诊断）。
- `account_lifecycle` 增加 `size` 列（老库自动 ALTER 补列）：`/api/del` 留痕同时记删前总发放，
  让「重录时连续性判定」也能做 size 抵扣。
- `pickGenerationStart` 同步 size 感知：包消失造成的等量同掉不算世代边界。

### Notes

- +9 条测试（82 passed / 0 failed）：新增 `worstUnexplainedStep`、入账永不触发、
  包消失 >1000 等量同掉不误判、size 只解释等量部分（边界 1000 / 1000.01）、
  锚点无 size 时用累计当下界、大额入账+账目仍重建、起点选取 size 感知，
  以及端到端 F（大额包变动）/ G（全新账号 + >1000 入账）两个场景。
- **真实数据副本回归**：清空世代后按新逻辑重判 → 仍精准命中 小陈TRAE
  （`explained 1447.4` / `unexplained 2952.6` / 起点 09-23 / base 3847.4），
  其余 11 个账号 `drop 0 / unexplained 0`，无假阳性。
- 变异测试：去掉 size 抵扣 → 4 条变红；去掉起点 size 感知 → 1 条变红；阈值改 100 → 8 条变红。

## [1.7.2] - 2026-09-24（账号重建隔离：累计不再被「删除→重录」的上一世污染）

### Added

- **世代起点 `epoch_start`（新表）**：每个 uin 记录当前「世代」的数据起点日与锚点。
  `startDay` 之前的数据一律不计入累计求和 / 水位线托底 / 日增量累加 —— 明细保留可追溯，
  隔离由世代边界负责。
- **账号生命周期留痕 `account_lifecycle`（新表）**：`/api/del` 删除账号时记下删前瞬时累计，
  供「重录时连续性判定」使用；世代重置也留档（审计/排查）。
- **判定模块 `src/compute/epoch.js`**：`decideEpochBreak` / `pickGenerationStart` 均为纯函数。
  - 有删除留痕 → 连续性判定：重录后首条累计与删前连续（差 ≤ `READD_TOLERANCE` 300）视为同一账号、
    继承历史；断裂 → 判 `removed-readd`。留痕判定过一次即不再重复触发（幂等）。
  - 无留痕（服务端侧重建）→ 断崖判定：当前累计比参照水位低超过 `RESET_DROP` 1000 即判 `cum-drop`。
  - 参照水位 = max(当前世代快照的最大累计, `consumed_baseline`) —— 后者必须有，否则
    gc 清掉旧明细后连断崖证据一起消失，永远检不出来。
- **`POST /api/epoch/detect`**（幂等，手动纠偏/运维）、**`GET /api/epoch/status`**（世代起点一览 +
  最近生命周期事件）。采样后由 `sample.js` 自动跑一次判定（失败不影响采样主链路）。
- `derived` 每账号新增 `epoch` 字段（`{startDay, base, reason, detectedAt}`，无重建为 null）。

### Fixed

- **账号「删除 → 重新录入」导致累计虚高**（实测小陈TRAE +4400）。链路：
  锚点/日摘要/水位线都按 uin 存，删除只写墓碑、不碰时序数据；重录后同 uin 的历史整体复活，
  `loadBaseline(uin)` 拿到上一世锚点 8247.4，而这一世到 09-22 只累计 3847.4。
  隔离后该账号累计回归 3847.4，12 账号合计 20768.19 → 16368.19。
- 顺带暴露的口径缺口一并记入注释：`clearDaySummaries()` 全仓从未被调用、
  `consumed_baseline` 无删除路径 —— 与世代边界配合后不再是隐患。

### Notes

- +18 条单测（判定阈值边界 `/ 有留痕与无留痕两分支 / 幂等 / 二次重建 / 起点选取`），68 passed / 0 failed。
- 实测分辨力：命中账号跌幅 4600，未命中账号最大跌幅 400（小黄WB）→ 阈值 1000 留有充分余量。
- 写错 `pickGenerationStart` 的 `prev` 重置时被 2 条断言当场抓住（反向验证断言有效）。
- **新增 `test/epoch_e2e.test.mjs`（5 条端到端）**：纯函数单测覆盖不到 IO 层（appendSnapshot /
  logLifecycle / setBaseline / derive 的组合），而"会不会算错"恰恰藏在那一层。该文件在临时
  `TRAE_TOOLS_DIR` 里真跑完整链路：删除留痕→重录→判定→派生，覆盖 重建隔离 / 连续继承 /
  无留痕断崖 / 正常账号不误判 / 上一世明细被 gc 后仍能检出 五个场景。
  **变异验证**：关掉 derive 的世代过滤 → 端到端立刻 2 条变红。全套 73 passed / 0 failed。
- harness 两坑（写错就得假绿/假红，已在测试文件头注明）：`appendSnapshot` 的分钟级去重是
  **全局**的（不带 uin），各场景须用不同分钟；`logLifecycle` 用 now() 当时间，重录后的快照
  ts 必须晚于 now() 否则留痕分支不触发。

## [1.7.1] - 2026-09-24（累计消耗蒸发修复：基线初始化当日合并）

### Fixed

- **累计消耗"蒸发"**（实测：总消耗两天只涨 365，实际用量 815，差 450）。根因：
  基线初始化发生在 09-22 中午（v1.6.1 部署时刻，base=当时最大瞬时消耗、
  asOfDay=09-22），当天**午后/晚间**的消耗在次日 gc 固化时被
  `day <= asOfDay` 跳过条件拦住（该条件假设"基线已涵盖全天"——只对"初始化发生在
  当天 00:00"成立），明细随即删除 → 这段消耗蒸发（坤坤WB -420 / 鲁妈妈WB -84）。
  修复：`bumpBaseline` 新增 dayMax 参数——`day === asOfDay` 时
  base = max(base, 当日最大瞬时消耗)（包内 giftUsed 单调，当日最大即截至当日结束的
  累计，不与 delta 相加避免重复计入初始化前部分）；`day < asOfDay` 仍跳过；
  `day > asOfDay` 原语义不变。
- 数据修复：坤坤WB 基线 447→726（按 09-23 首条 giftUsed 实测回填）。

### Notes

- +5 条单测（初始化当日合并/幂等/未超保持/更早跳过/原语义），50 passed / 0 failed。
## [1.7.0] - 2026-09-23（每日自动签到：TRAE + WorkBuddy 双源进调度器）

### Added

- **每日自动签到**（新增 `src/compute/checkin.js`）：采样调度器每日到点
  （中国墙钟 +8，默认 **8 点后首个采样 tick**，env `TRAE_CHECKIN_HOUR` 可调 0-23）
  自动执行一轮签到——复用 CLI `checkin` 的双源幂等逻辑
  （TRAE=storage.json 现解密 token；WorkBuddy=.info Bearer，已签自动跳过）。
  **只读 JWT + deviceId，不碰 RefreshToken**——与切器保鲜（RT 单写者）天然无冲突。
- **凭证保鲜前置**：签到前先 `pullRemoteSlots`（拉云端 `trae-credits/登录态` 标准树，
  SSR 只读）→ `reconcileFromDisk`（对账入库）——用户在专用设备重登推槽后，
  签到自动用上新凭证，无需手工同步账号池。
- **API**：`POST /api/checkin/run`（手动触发，body `{dryRun:true}` 只查不领）+
  `GET /api/checkin/status`（状态 + 最近 10 天历史）。结果落
  `TOOLS_DIR/checkin-state.json` / `checkin-history.json`（留 120 天）。

### Notes

- 时区口径统一走 time.js 中国墙钟（容器 UTC 不错天）；判据 `shouldRunCheckinNow`
  为纯函数，4 条单测钉死（阈值前/后、当日防重、跨天边界、env 覆盖限幅）。
- 45 passed / 0 failed（新增 test/checkin.test.mjs 4 条）。

## [1.6.1] - 2026-09-22（累计消耗改「截至昨日」口径，根治"总消耗变少"）

### Fixed

- **`tool.json` 版本号漏同步**：`tool.json` 停在 `1.6.0`，而 `package.json` 与本 CHANGELOG
  已是 `1.6.1` → 平台卡片/工具元数据报的是旧版本。已同步为 `1.6.1`；顺带把 GUI 的
  `?v=v1.6.x` 缓存串与页脚版本串一起对齐（`wb-gui.html` 7 处、`wb-gui.render.js` 2 处）。
  （源文件里的 `// v1.6.0` 注释是"该能力在 1.6.0 引入"的历史标注，**不**改。）
- **累计消耗不再随服务端回收过期包而回落**。根因：服务端 `usage_summary.consumed_amount`
  **不是**历史累计，它 ≡「当前仍存在的积分包的已用之和」（12 账号实测，两者差仅浮点误差）。
  服务端回收过期包 → 该包已用额度被抹掉 → 该值整体回落。570 快照实测下降 **11 次、每次整 100**，
  且 `giftSize` 同减、`giftRemain` 不变（cap=100 / rem=0 / status=3 的包被摘掉的指纹）。
- 受影响的是 **WorkBuddy 账号**（UUID uin）；TRAE 账号口径正常，从未下降。
- 修正两处把 `consumed_amount` 描述成"服务器权威累计消耗（单调非负增长）"的错误注释。

### Added

- `consumed_baseline` 表（`uin, base, asOfDay, updatedAt`）：持久化「截至最后一个已固化日结束」
  的累计消耗。`gc` 固化某日时并入当日正增量（明细随后即被删除，不并入就永久丢失）。
- `consumedTotal` = `consumed` + `todayUsed`（含今日的全量累计）。
- 回归测试「包回收致 giftUsed 回落，consumed 不回退」。

### Changed

- **`consumed` 语义改为「截至昨日结束」（不含今日）**＝
  `max(base + Σ未固化日正增量, 今日前水位线)`。水位线在 base 尚未建立时托底。
  今日的实时波动全部归到「今日消耗」列，总消耗成为每日只变一次的稳定值。
- base 初始化取 `maxGiftUsed` 时已含历史增量，故新增 `asOfDay`：仅当 `day > asOfDay` 才并入，
  否则会重复计算（实测小黄 base 被抬到 1575 > 真实 1017）。

### 验证

- `node --test` **41 passed / 0 failed**；反向对照（把 `consumed` 改回 `used`）→ 2 个测试变红。
- 线上 12 账号：`consumed` 全部 ≥ `used`；坤坤 `consumed 511 / consumedTotal 912 /
  todayUsed 401`（今日已正确排除）；间隔 8 秒两次取样数值完全不变。

## [1.6.0] - 2026-09-22（采样后自动推送精简快照）

### Added

- `src/compute/publish.js`：由本次采样结果构建**精简快照**并推送到 WebDAV 的 `BACKUP_DIR`
  （`workbuddy/workbuddy登录积分/trae积分/trae-credits-snapshot.json`，实测约 2.5KB），
  供 MultiSwitch（登录态切换器）槽卡读取 —— 它原先只能逐槽解密 + 直连 `api.trae.cn`
  （12 个账号 12 次外网请求）。快照字段：`uin / app / name / displayName / remain /
  used / size / packs / signedIn / nextExpiry`，`schema: 1`。
- `GET /api/publish/status`：发布状态（最近时间 / 指纹 / 上次结果 / 落点文件名），排查用。

### 设计约束（采样是主流程，发布是附属能力）

- **不 await**：在 `sample.js` 采样落盘后 fire-and-forget，发布慢或失败都不拖慢采样。
- **不抛**：异常全在模块内吞掉，只体现在返回值的 `reason`（`published` /
  `no-entries` / `no-accounts` / `no-webdav-config` / `unchanged` / `throttled` /
  `in-flight` / `error`）里。
- **不刷屏**：最小间隔 5min 节流 + 内容指纹去重（指纹刻意**不含** `generatedAt`，
  否则每次采样时间戳都变、去重永远失效）+ 进程内防重入。

### 为什么不推 trae-history.json

那是 2.4MB 的全量时序账本，而服务端上传吞吐实测只有 6~25 KB/s，每次采样都推会拖垮链路。

### 部署前置（本版新增依赖）

- 推送复用既有的 `wb-sync.json` 配置。**若 `url` 为空则一律跳过**（返回
  `no-webdav-config`，不报错）—— 也就是说：url 没填的实例，功能不会生效，
  切器侧只会显示「远端不可达」。填一次 `url` 即全自动。

## [Unreleased] - 2026-09-20（⚠️ 待验证，验证成功后才启用）

> **重要约定**：本段全部变更**尚未通过正式验证，验证成功前不得转正、不得作为正式功能使用**（不得写入正式版本段、不得随正式版打包发布）。下次验证步骤与通过标准见交接文档 `04-本次修复交接.md` §8；验证全部通过后才允许把本段内容移入正式版本段并删除本约定。

### Added（2026-09-20 晚追加：解密能力进程序）

- `resolveAtRestKey()`（`src/compute/wb-decrypt.js`）：key 文件（`wb-atrest-key.json`）
  缺失/损坏时**自动运行 `tools/wb-keygen.py` 重新提取**（依次尝试 `python`/`py -3`，
  每进程一次，180s 超时），失败落回原错误提示。端到端实测：删 key → 程序自动
  重建 → 回归 8/8 PASS（TotalDosage=3377/45 包）。

### Added（WorkBuddy $wbEncrypted 加密凭证自动解密，实验性，待完整验证后转正）

- **背景**：新版 WorkBuddy 客户端把 `.info` 内 `accessToken`/`refreshToken`/`nickname`/`phoneNumber` 等字段加密为 `{"$wbEncrypted":1,"envelope":"<base64>"}`（AES-256-GCM，sym-v1 field 框架），积分程序原 `readWbInfo` 直读明文失败，导致查询 401/无 accessToken。
- **新增 `src/compute/wb-decrypt.js`**：`isWbEncrypted` / `decryptWbField` / `decryptWbInfo` / `resolveAtRestKey`，实现与客户端一致的 AAD 构造（`WB-AAD\0` + field 框架 + sym-v1）与 AES-256-GCM 解密。密钥为运行时的 at-rest symmetricKey，**绝不随代码分发**：从环境变量 `WB_ATREST_KEY`(base64) 或 `TOOLS_DIR/wb-atrest-key.json` 读取（已加入 .gitignore）。
- **新增 `tools/wb-keygen.py`**：扫描本机 WorkBuddy 主进程内存中的 bootstrap JSON（`{"policy":"fields","symmetricKey":{...}}`），提取并校验 keyId=SHA256(key)[:16] 后生成密钥文件；ToolHelp32 枚举异常时自动回退 PowerShell。
- **`src/compute/wb.js` `readWbInfo`**：accessToken 为 `$wbEncrypted` 时现场解密后再解析；解密失败抛出带配置指引的明确错误。
- **新增 `tools/regression/wb-decrypt-test.mjs`**：本机真实加密 `.info` 的端到端回归（解密 → 真实 `get-user-resource` 查询）。

### Verified（本机真实加密凭证）

- `wb-keygen.py` 自动发现 WorkBuddy 主进程，命中 bootstrap，keyId 校验通过。
- 回归测试 8/8 通过：readWbInfo 自动解密、JWT 校验、全文/单字段解密、真实积分查询成功（TotalDosage=1465、13 包）。
- 其余 5 个账号（鲁妈妈/花轮的丸子樱桃味/擎天柱/小陈/小黄）凭证仍为明文，查询全部正常。
- **2026-09-20 晚追加（新登录账号·全加密态复验）**：重新登录后 live `.info` 为全加密态
  （nickname/accessToken/refreshToken 均 `$wbEncrypted`），`wb-keygen.py` 提取 keyId
  `9127dea1…` 与 envelope 配对校验 PASS，回归 **8/8 全 PASS**，真实积分查询成功
  （TotalDosage=3316、43 包，两次运行数值随实时用量变化）。**key 跨客户端重启稳定**
  （重启后 envelope keyId 不变，已缓存的密钥文件继续有效）。
- **wb-keygen 可靠性修复 ×3（本次验证暴露）**：
  ① `scan_for_bootstrap` 原 rfind `{"version":1` 会落到无关的 UI bootstrap（键序变化）
  → 改为对每个 `"policy":"fields"` 标记做反向括号提取、多候选逐个尝试；
  ② ToolHelp32 进程枚举偶发漏掉持有 bootstrap 的进程（13 个只返回 2 个）
  → ToolHelp32 与 PowerShell 双路合并去重；
  ③ 增加外层 3 轮重试（进程枚举/内存布局漂移，单轮偶发漏扫）。

### 下次验证清单（全部通过后才转正启用）

- ~~本机新登录账号（全加密态）解密回归~~ ✅ 2026-09-20 通过（8/8 + 真实查询）。
- ~~密钥跨客户端重启稳定性~~ ✅ 2026-09-20 通过（keyId 不变，缓存 key 持续有效）。
- 打包版（GUI/CLI 部署形态）下的完整回归与 UI 展示。
- 验证操作步骤与通过标准以交接文档 `04-本次修复交接.md` §8 为准。

## [1.5.2] - 2026-09-13

### Fixed（过期排序顺序错误：`Infinity` 经 JSON 序列化变 `null` + 今天到期被漏计）

- **根因一（主因）**：后端 `derive.js` 的 `expiryTier` 用 `{ tier: Infinity }` 表示「30 天内无到期压力」，但接口返回经 `JSON.stringify` 序列化后 `Infinity` 变 `null`；前端 `sortByExpiring()` 比较器 `ta.tier - tb.tier` 把 `null` 当 0 参与运算，导致**无到期压力的账号反而排到最前**，且「无压力按总剩余降序垫底」分支（`=== Infinity`）永不触发、组内顺序也乱。
- **修复一**：`wb-gui.state.js` 的 `expiryTier()` 读取点统一归一——`tier` 非 number（null/缺失）→ `Infinity`，`amount` 兜底 0。单一入口处理，比较器与其它消费方无需改动；账号拉取失败/无派生数据（`r.derived` 为空）时同样正确落到无压力组。
- **根因二**：tier 计算 `diff >= 1` 才计入，到期日为**今天**（diff=0）的积分包不算紧迫度，与 `expiring1d`（含今天）口径不一致——「今天就过期」的账号被误归入无压力组排最后。
- **修复二**：`derive.js` tier 范围改 `diff >= 0`，今天到期 = 最紧迫层（tier 0）。
- **实证确认**：`test/derive.test.mjs` 12/12 通过；模拟比较器实测顺序 = 今天到期 → 明天到期 → 5 天后到期 → 无压力组（按总剩余降序）；线上 `/api/derived` 实测返回 `{"tier":13,"amount":592.43}` 与 `{"tier":null,"amount":0}` 两种形态，前端归一后排序正确。

## [1.5.1] - 2026-09-12

### Fixed（账户管理视图单一真相缺口：`/api/accounts` 读前未对账）

- **根因**：`/api/accounts`（账户管理列表接口）此前直接 `loadAccounts()` 返回，**绕过** `reconcileFromDisk()`，而 `/api/all`、`/api/dashboard/all`、`/api/derived`、`getDerived` 等全部其它读路径都已先 `reconcileFromDisk()`（扫描本机/槽登录态、自动把新发现的登录态槽入库）。于是「账户管理」视图与「主列表/仪表盘」会出现**不一致**：新增的登录态槽进了主列表、却没进账户管理，违反单一真相。
- **修复**：`/api/accounts` handler 改为 `async` + `await reconcileFromDisk()`，返回前先对账（与全部其它读路径一致），账户管理视图与主列表同步可见。分发层已统一 `try/catch`，handler 异步拒绝降级为 500 而非进程崩溃。
- **实证确认（重启复现）**：构造临时登录态槽探针，`旧路径(loadAccounts)`=12、`新路径(reconcileFromDisk/mergeDiscovered)`=13，stale-read gap 真实存在（`oldPathMissedNewSlot=true`）；因 `mergeDiscovered` 仅改内存、不落库，DB 未被污染，临时槽已清理。结论：**确为真实 bug，已修复**。

### Added（场景走查审计，发布质量门禁）

- **scenario-walkthrough 技能 v3 全量走查**：覆盖能力 C-IDs + 场景脚本 S-01…S-11 + 覆盖矩阵 + 分级代码走读 + 风险评分问题清单（风险 = 复杂度 L × 影响 I）+ 结论三问。
- 走查确认修复后 **8/8 读路径** 统一走 `reconcileFromDisk()`，单一真相闭环无残留旁路。

### Changed（发布规范：每次发包只发两个形态）

- 平台版（tools-center 宿主，端口 8133，`node trae-gui.mjs 8133`）+ Windows/bat 桌面版（端口 8080，`trae-gui.bat` 一键启动）双形态发布；`Dockerfile`/`docker-compose.yml`/`.dockerignore` 同步修正为 TRAE 形态（原遗留为 WorkBuddy `wb-*` 旧版）。
- `.gitignore` 补 `backups/`、`*.db*`、`_probe.mjs`、`trae-admin.json`，杜绝登录态槽/管理员密码入库泄漏。

## [1.5.0] - 2026-09-11

### Changed（两程序标准树联动：切先器推「积分标准树」、积分程序直拉即用，根治路径错位）

- **根因**：此前积分程序需到切先器的 `workbuddy/workbuddy登录积分/<app_id>/` 目录找 `.zip`、凭「app 名映射(`traework-cn`→`trae`)」猜目录、下载 zip 再解压，再靠 uid 匹配——逻辑绕、跨机路径易失效，导致平台版查询失败。
- **切换程序侧（本仓库 `sync_engine.py`）**：同步/上传每个槽时，额外输出第二份，把登录态凭证按积分程序标准目录树直接布放到 WebDAV `trae-credits/登录态`：
  - WorkBuddy → `<root>/workbuddy/<槽>/workbuddy-desktop.info`
  - TRAE → `<root>/trae/<槽>/User/globalStorage/storage.json`
  只推凭证文件、不带多余缓存，格式与积分程序 discover/config 完全一致。
- **积分程序侧**：
  - `webdav.js`：`pullRemoteSlots` 重写为从 `trae-credits/登录态` 直接列目录 + 下载标准凭证文件落盘到本工具指定登录态根，去掉 zip 解压与 app 名映射。
  - `paths.js`：`resolveSlotPath` 失效路径时，**WorkBuddy 与 TRAE 都先按槽内凭证 `uid` 对照账号 `uin` 精确路由**（uid 是两程序一致的稳定身份），匹配不到才退回槽名目录兜底；删除对桌面切先器绝对路径的依赖。

### Verified

- 真实联调（WebDAV `192.168.2.1:6086`）：切先器 `_push_credits` 推送部署机 7 槽（5 WorkBuddy + 2 TRAE）到 `trae-credits/登录态` 成功；积分程序 `pullRemoteSlots` 直拉 7 槽全部落盘，目录结构符合标准。
- 部署机场景模拟（cookieHeader 全指失效路径，仅标准树落盘）：7 账号全部按 uid 精确命中标准树，`fetchAllAccounts` 真实查询 7/7 成功、积分数据完整，不再读任何桌面旧路径。

## [1.4.79] - 2026-09-11

### Fixed（两程序联调：账号 ↔ 槽 按 uid 精确路由，根治平台版查询失败）

- **根因**：切换程序(LloginStateSwitcher)上传的槽目录以手机号/字母命名（如 `15182508595`、`A`），账号池里的显示名（`小黄`/`小陈`/`鲁妈妈`）与此**完全对不上**；且槽内 `.info` 无 displayName/name，只有 `uid`。原「按槽名目录/显示名匹配」必然错位，导致平台版 `指定根/<槽>/workbuddy-desktop.info` 找不到。
- **修复**：`resolveSlotPath` 失效路径时，WB 优先**扫描本工具指定根下的槽、按槽内凭证 `uid` 对照账号 `uin` 精确路由**（uid 是两程序一致的稳定身份键），匹配不到才退回槽名目录兜底。`rewriteAccountPaths` 同步复用同一套解析，保证落库 cookieHeader 规范一致，查询不再 ENOENT。
- **风险隔离**：TRAE 槽因切换程序本地 `backups/trae/` 缺失而拉不到，属切换侧数据缺失；本版在槽缺失时给出明确「未找到登录态槽，请云同步/在切换程序建槽」提示，不再误报「既非路径也非内联 token」。

### Verified

- 真实联调：`小黄`(uin f1cb…)→槽`19149458590`、`鲁妈妈`(f076…)→槽`15182508595`、`小陈`(520b…)→槽`B`，全部 uid 命中且凭证文件存在。
- 端到端 pack→extract：切换程序 `slot_pack` 打包出的 zip 内含规范 `workbuddy-desktop.info`，积分程序解压后文件存在，格式契约吻合。

## [1.4.78] - 2026-09-11

### Changed（依可信来源修正「路径的写法」，规避跨机绝对路径 + JSON 反斜杠转义陷阱）

- **持久化路径一律正斜杠**：`paths.rewriteAccountPaths` 重写的 `cookieHeader` 与 `discover.toAccountRec/toWbAccountRec` 采样入库的 `cookieHeader` 都改为 `\`→`/`（内联凭证 JSON `{ `[` 开头原样不动）。跨机池经 WebDAV/JSON 同步时不再被 `\b \n \t \u` 等合法转义吞字符写坏（如 `\backups` 会被 `\b` 吞成退格字符），路径裸奔安全。
- **fs 层才转回原生路径**：`trae-decrypt.readAccountAuth`、`query.fetchWbAccount` 在 `existsSync/read` 前 `path.normalize()`（内部正斜杠统一，仅外部交互转原生），符合路径最佳实践。
- 查询仍是「按槽名确定性拼本工具指定根」一条直路，绝不再读跨机绝对路径、不再目录扫描/同名猜测。

### Verified

- 平台型全新安装模拟（含中文槽名 + 反斜杠池 + 非本机路径 + `TRAE_TOOLS_DIR`=自身 data）：7 账号全部解出 token，0 失败；全程不读桌面绝对路径。

## [1.4.77] - 2026-09-11

### Changed（按要求砍掉「太绕」的路径逻辑）

- **凭证路径解析改为「直读指定目录」一条直路，删除全部扫描/猜测**：旧的 `resolveSlotPath` 会在查询时去 `<指定根>` 里遍历目录、按 `slot.includes(displayName)` 做同名模糊匹配、再叠 `infoUidMatch` 精校、`latestInfo` 兜底等一堆耗时又易错的逻辑。现在只有一个确定性动作——账号槽名 = `slotName` 字段，或从现有 `cookieHeader` 的 `backups/<app>/<槽>` 段确定性回填，然后直接拼 `<指定根>/<槽>/<凭证文件>`。不再 `readdir` 扫描、不再按名字猜目录。
- **槽根收敛为单一真源**：`config.js` 新增 `trailSlotRoot(wb)`（env `WB_SLOT_ROOT`/`TRAE_SLOT_ROOT` 优先，否则 `TOOLS_DIR/backups/<app>`）；`wbSlotRoots()`/`traeSlotRoots()`、`paths.js`、`webdav.js` 的拉取落盘（`resetSlotDir`/`autoPullSlotsIfMissing`）全部共用这一个根，删掉原先 4~7 条的桌面切换器路径候选列表。
- **不再猜 displayName/name 作槽名**：`坤坤`(槽=`花轮的丸子樱桃味`)、`爸爸`(槽=`擎天柱`)、`小陈 trae`(槽=`小陈`) 这类「展示名 ≠ 槽目录名」的情况，旧逻辑靠模糊匹配勉强对上，新逻辑一律不猜：取不到确定性槽名就直接报「未找到登录态槽」，提示先云同步/设环境变量。
- **错误提示明确**：`trae-decrypt:readAccountAuth` 与 `query:fetchWbAccount` 计算出槽路径但文件缺失时，报「本机未找到该账号登录态槽: <路径>，请先「云同步」拉取登录态或设置 WB_SLOT_ROOT/TRAE_SLOT_ROOT」，不再误报「凭证既非文件路径也非合法 JSON」。
- 账号扫描入库（`discover.js`）补 `slotName` 字段，新采集的账号不再依赖路径回填。

### Verified

- 真实账号池 7 账号端到端：本机桌面路径存在 → 直接命中；模拟平台（原 `cookieHeader` 保留槽段、文件本机不存在）→ **7/7 全部确定性重指到本工具指定根下的槽并存在**，无 `readdir` 扫描、无同名猜测。

## [1.4.76] - 2026-09-11

### Fixed

- **查询自愈找不到部署机专用槽（平台版一直报错 ENOENT 的根因）**：`paths.js:resolveSlotPath` 此前固定只在 `TOOLS_DIR/backups/<app>` 下找槽，而部署机把登录态拉到自己的**专用目录**（经 `WB_SLOT_ROOT`/`TRAE_SLOT_ROOT` 环境变量指向），账号发现 `discoverDataRoots`/`discoverWbInfoFiles` 能命中、查询自愈却完全搜不到 → 自愈返回空 → 回退失效桌面路径 → ENOENT。
  - 根因修复：把「槽根候选」收敛为 `config.js` 的 `wbSlotRoots()`/`traeSlotRoots()`，**账号发现与查询自愈共用同一套根**（env 显式指向的部署机专用目录优先 + 常见切换器路径 + `TOOLS_DIR/backups`），`resolveSlotPath` 改为遍历全部候选根 + 同名槽去重匹配。部署机无论登录态放在哪，只要通过环境变量指向，查询即自愈，不再 ENOENT。
- **凭证防泄漏**：`wb-sync.json` 模板脱敏——`user`/`pass` 置空（仅保留默认可用 `url`），彻底移除进发布包/仓库的明文 WebDAV 凭据。

### Verified

- 端到端实测（真实账号池 7 账号 + 槽放在**模拟部署机专用目录**、原桌面路径不存在、`TOOLS_DIR` 为空）：`resolveSlotPath` **7/7 全部自愈到专用目录并读到 token**；真实在线查询官方接口 **7/7 全部成功**（小黄3822/坤坤3973/爸爸3901/鲁妈妈3445/小陈trae3540/小陈6219/小黄trae3642），无 ENOENT。

## [1.4.75] - 2026-09-11

### Fixed

- **界面版本号统一（此前一直显示旧版，导致误判旧包/查询失败）**：界面底部 `v1.4.73` 与 HTML 缓存版本号 `?v=v1.4.73` 是硬编码，此前仅改 `package.json`/`tool.json`，漏改了界面展示——把 `wb-gui.render.js` 与 `wb-gui.html` 全部统一为当前版本号。
- **凭证防泄漏**：`.gitignore` 补充 `trae-credits-tool/backups/`（`TOOLS_DIR/backups` 存放从 WebDAV 拉回的账号登录态槽，根级 `backups/` 规则命中不到该子目录，未排除则推送时写入仓库泄漏全部 `.info` 登录态）。

### Verified

- 端到端实测（真实账号池 7 账号 + 已拉满 `TOOLS_DIR/backups`）：`fetchAllAccounts()` **7/7 全部查询成功**（WorkBuddy 4 + TRAE 2 + WorkBuddy 小陈），总剩余等积分数值正确，路径自愈 + 自动拉槽 + token 解密 + api.trae.cn 查询整条链路正常。

## [1.4.74] - 2026-09-11

### Added

- **查询端凭证路径自愈（平台版/换机，关键修复）**：新增 `src/compute/paths.js`（`resolveSlotPath` + `rewriteAccountPaths` 单一真源）。此前失效路径只在「一键同步」时重写，若平台部署后未触发同步，旧账号池 `trae-accounts.json` 仍指向本机桌面绝对路径 → 查询 ENOENT「查询失败」。
  - `resolveSlotPath(account)`：**读取凭证时**，若 `cookieHeader` 路径不存在，自动按 `appKey` + 槽名/displayName/name（workbuddy 追加 auth.account.uid 精校）回退到本地已拉取槽（`TOOLS_DIR/backups/workbuddy|trae/<槽>`），workbuddy 走 `readWbInfo`、TRAE 走 `readAccountAuth`，均自愈。
  - 效果：只要槽已被拉取到本地，查询即自动命中，**无需依赖手工再跑同步**；本机桌面场景路径有效则零影响。
- **路径逻辑收敛**：`rewriteAccountPaths` 由 `webdav.js` 收敛到 `paths.js`（`webdav.js` 再导出兼容），消除重复实现。
- **测试**：`test/paths.test.mjs` 新增 5 项（失效路径命中本地槽 / uid 不符同名槽不误配 / 有效路径与内联原样返回 / batch 重写），`npm test` 26/26。
- **部署机免手动同步（自动拉槽）**：`webdav.js` 新增幂等 `autoPullSlotsIfMissing()`，`query.js` 的 `fetchAllAccounts` / `fetchOneAccount` 在查询前调用——`wb-sync.json` 已配 `url/user` 且本地 `TOOLS_DIR/backups` 完全无槽时，自动触发一次 `pullRemoteSlots` 拉回登录态槽（进程内只尝试一次，成功或失败均标记，避免周期刷新反复重建目录；失败静默不影响查询）。部署机**配好 WebDAV 后无需手动点同步**，刷新/重启即自愈。

## [1.4.73] - 2026-09-11

### Added

- **云同步拉取账号槽（只读）**：`webdav.js` 新增 `pullRemoteSlots(cfg)`，一键同步（`syncNow`）时从 MultiSwitch 同步到 WebDAV 的 `workbuddy/workbuddy登录积分/{workbuddy,traework-cn}` 目录**只读拉取**登录态槽 `.zip`，解压到本机 `TOOLS_DIR/backups/workbuddy|trae/<槽>`（远端 app 名映射回本机切换器目录结构），供 `discoverDataRoots()` / `discoverWbInfoFiles()` 识别。
  - 换机后仅需配置 WebDAV 并「一键同步」→ 账号登录态即被拉回并扫描建池；**只拉不传**，账号数据不上传。
  - 槽拉取失败不影响原有 `trae积分/` 镜像同步；成功时在完成提示追加 `,拉取账号槽 …`。
  - 解压优先系统 `tar`，回退 PowerShell `Expand-Archive`，保持零第三方依赖。
- **槽发现候选根**：`config.js` `discoverDataRoots()` 与 `wb.js` `discoverWbInfoFiles()` 各增补 `TOOLS_DIR/backups/trae`、`backups/workbuddy` 候选根，覆盖独立部署（含 Docker 平台版）拉取槽的发现。

### Fixed

- **平台版/换机后查询失败（失效路径）**：账号池 `cookieHeader` 常指向【本机桌面】MultiSwitch 槽绝对路径（`Desktop\登录态切换器\backups\...`），部署到平台版/新机后该路径不存在 → 查询报 ENOENT /「凭证既非文件路径」。新增 `rewriteAccountPaths(accounts)`，在「一键同步」拉取账号槽到 `TOOLS_DIR/backups/<app>/<槽>` 后，把仍指向不存在路径的 `cookieHeader` 按槽名重写为本地新拉取槽，重写结果随 `uploadAll` 上传保证跨端一致（重写条数计入完成提示 `,重写凭证路径 N 条`）。
- **端口冲突**：平台版由 8123（与 `wb-credits` 在册冲突）迁至 **8133**，已登记 `tools-center/docs/ports.md`，`tool.json` 与 README「平台版」同步更新。

### Notes

- v1.4.72 与 v1.4.73 绑定发布，v1.4.72 Release 已被 v1.4.73 取代删除。

## [0.1.0] - 2026-09-10

### Added（本轮「长远项目审视」加固）

- **P0 · 派生口径单测与业务常量上移**
  - 新增 `test/derive.test.mjs`：锁定 `consumeByUsed`（正增量累加 + 新旧格式感知）、`todayAddedFrom`（`SIGNIN_CREDIT`）、`deriveGiftExpiry`（空/非法包过滤）。
  - 新增 `test/db.derive.test.mjs`：真实 SQLite 隔离（临时 `TRAE_TOOLS_DIR`）验证 `deriveAccount` 与 `gcDaySummaries` 固化窗口。
  - 业务常量 `SIGNIN_CREDIT = { workbuddy:100, traework:150 }`、`DEFAULT_SIGNIN_CREDIT` 从 `derive.js` 上移到 `config.js`；新增可测纯函数 `todayAddedFrom`。
- **P1 · WebDAV 双写桥接收敛**
  - 新增 `src/store/syncbridge.js` 作为同步账本文件清单的**唯一真源**（`ACCOUNTS_FILE` / `HISTORY_FILE` / `SYNC_FILES`），`store`/`history`/`webdav` 三处统一引用，消除清单漂移。
  - 新增 `test/syncbridge.test.mjs`：同步"导出→清空→导入"幂等往返，锁定时序/账号归位行为。
  - `webdav.js`：`syncNow` 拉取文件名由写死字面量改为 `SYNC_FILES` 解构（`ACC_FNAME`/`HIST_FNAME`）；移除未使用的 `importAccounts` 导入；保留 `ACCOUNTS_FILE`/`SYNC_FILES` 兼容导出供 `trae-gui` 消费。
- **P2 · 凭据防入库鉴扫**
  - `.gitignore` 补齐 `wb-sync.json`（WebDAV 同步配置，含用户名/密码）。
  - 新增 `test/security.test.mjs`：断言凭据/账本文件必须被 `.gitignore` 覆盖、清单真源与忽略规则闭环、`workbuddy-checkin/` 子模块忽略 token 文件。

### Changed

- `package.json`：新增 `"test": "node --test"`。
- README：新增「架构」章节（单真源/单采集入口/分层无环依赖 + 口径不变量），开发与测试补充 `npm test`。

### Notes

- 【数据修复 2026-09-11】`day_summary` 中 2026-09-09 的 `used` 全部为迁移/污染遗留的错误值（workbuddy 各账号 3920/3837/1923/1000/400、trae 147.01/223.33），与当日快照净变化矛盾（当日仅签到 +100）。已按格式感知 `consumeByUsed` 重算修正为真实消耗（workbuddy 均 0、小陈 trae 74.94），备份见 `C:\Temp\backup_day_summary_2026-09-09.json`；校验 code 与 DB 全部一致。
- 口径修正（今日到账按来源签到常量 100/150；消耗为正增量+格式感知）已通过测试回填真实快照验证，仪表盘运行实例已重启确认。
- 一次性排查脚本（`C:\Temp\wb_restore`）不入库，已用 `tools/regression/derive-audit.mjs` + `readings-seq.mjs` 两个可移植参数化巡检脚本替代，可对任意机器/时间复跑。
- 已知：本机环境 git 不在 PATH；`.gitignore` 生效依赖鉴扫测试守卫（`npm test`）与未来 CI。