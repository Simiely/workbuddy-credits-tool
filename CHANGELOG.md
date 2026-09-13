# Changelog

本文件记录 trae-credits-tool 的口径/架构/测试相关变更。遵循 Keep a Changelog 风格，语义化版本。

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