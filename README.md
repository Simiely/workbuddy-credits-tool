# WorkBuddy 多账号积分工具

多账号采集 **WorkBuddy 积分**,提供命令行(CLI)与本地网页仪表盘(GUI)两种入口。
直接调用 WorkBuddy 网页版内部接口,无需开浏览器(账号采集用配套 Edge 插件,免调试浏览器)。

> **⚠️ 维护策略(v1.4.65 起)**:本仓库**只维护两个发布形态 —— [平台版](pack-platform.mjs)(tools-center 托管服务端)+ [Edge 插件版](extensions/wb-credits-capture/)(采集端)**。**bat 版(桌面 GUI/CLI)保留、随版本自然迭代,但不专门测试**。账号采集**统一走 Edge 插件**(chrome.cookies 官方 API)→ 导出 `wb-accounts.json` → 工具「📥 导入账号信息」;旧的「添加账号 / 打开网页 / edge-daemon(CDP 调试浏览器采集)」已于 v1.4.65 **移除并归档**到 `legacy/edge-daemon.mjs`。

> **平台版标注**:本工具可作为 **[tools-center](https://github.com/Simiely/tools-center)(轻量工具统一宿主)** 的托管工具部署(NAS 常驻),平台声明见 `tool.json`(app 型,端口 8123,`/api/status` 健康检查)。接入规范、目录结构、数据目录与升级步骤见 **`docs/tools-center部署.md`**;桌面/容器通用部署见 `docs/部署.md`。
>
> **配套扩展标注**:本仓库**同时维护**抓取扩展 [`extensions/wb-credits-capture/`](extensions/wb-credits-capture/)(免调试浏览器方案,读取浏览器登录态上传 WebDAV 供本工具导入)。改采集链路(账号池 schema / WebDAV 目录 / billing 接口)时**必须同步检查插件**,反之亦然。

## 功能特性

- **多账号池**:每个账号独立 cookie 凭证,一键批量查询,单账号失败不影响其他
- **CLI**:`import` / `accounts` / `rename` / `del` / `all` / 单账号查询,支持 `--json` / `--csv`
- **GUI 仪表盘**:深色主题、移动端适配;总剩余大数字状态层 → 消耗趋势(**柱状图**:每日/每月聚合、账号图例点击隐藏、每组最高的柱子标数字、右侧灰色**当日合计柱**)→ 账号卡片明细;趋势/总览面板**标题点击折叠**(状态记忆)
- **今日已用 vs 昨日**:箭头与昨天(自然日)对比,↑红=多用、↓绿=少用
- **签到标记**:卡片今日消耗行显示 ✅ 已签到 / ⏰ 未签到(元数据推断:新增「到期日=今天+1自然月(对日+月末钳制)」的赠送包,历史签到可回查)
- **到期明细**:账号总览表与合计行展示**近1/2/3/7天过期积分**,排序按钮「过期排序 | 使用排序 | 剩余排序」一键重排并持久化
- **消耗历史**:SQLite(`credits.db`)时序快照,自然日聚合,趋势图每日窗口跟随数据量(3~5 天,数据少从最早数据日向右延伸、多取最近 5 天;「每日」以今天为终点,截止日期选择可固定以指定日为终点显示最近 5 天、数据不足自动收缩到实际数据范围;「每月」以当月为终点显示最近 5 个月;「全部显示」看全量)
- **本地缓存**:最近一次完整数据落盘,断网/接口失败也能看
- **WebDAV 一键同步**:「🔄 同步」先拉远端合并进本地、再上传合并后全量(双向取最新,无损);删除带墓碑标记跨设备传播(不会因旧备份复活);自动同步定时可选;大文件下载/上传超时 120s,gc 固化后自动重导出镜像保持备份精简
- **导出 MD 报表**:按账号分节,可直接阅读/转 PDF
- **自动刷新**:间隔可调(1~1440 分钟) + SSE 实时推送,设置本地记忆
- **管理密码(可选)**:默认开放;「🔒 设置密码」启用后,危险写操作(增删账号/清空/配置)需本会话验证一次密码,「🔒 管理」输入当前密码即清除
- **签到标记**:每日签到(1-6天100分/天,第7天1000分)通过赠送包元数据推断(新增「到期日=今天+1自然月对日」的包,月末自动钳制),账号卡片显示 ✅已签到/⏰未签到 徽标;历史签到固化进日摘要可回查
- **容器部署**:自带 `Dockerfile` / `docker-compose.yml`,采集走文件/WebDAV,与桌面方案数据互通

## 快速开始

> 依赖:Node.js ≥ 18(开发环境 22.x),零第三方依赖;仅添加账号时需要 Edge 浏览器。

### 方式一:GUI 仪表盘(推荐)

```bash
node wb-gui.mjs        # 或 Windows 双击 wb-gui.bat
# 自动打开 http://127.0.0.1:8080(端口被占自动顺延)
```

### 方式二:命令行

```bash
node wb-credits.mjs accounts                     # 查看账号池
node wb-credits.mjs all                          # 一键批量查询全部账号
node wb-credits.mjs --account 1 --json           # 查询单个账号(原始 JSON)
```

### 首次使用:导入账号(采集统一走 Edge 插件)

> 💡 **采集方式(唯一)**:在 **Edge 浏览器**安装配套抓取扩展 [`wb-credits-capture`](extensions/wb-credits-capture/)(`edge://extensions` → 开发者模式 → 加载解压/拖入 zip)。日常浏览器登录 workbuddy.cn 后,点扩展「抓取当前账号」→「导出文件」得到 `wb-accounts.json`,再导入本工具:
>
> 1. 安装扩展 → 打开 workbuddy.cn 登录**账号 A** → 扩展「抓取当前账号」→「导出文件」;
> 2. 本工具 GUI 点 **「📥 导入账号信息」** 选该文件(或命令行 `node wb-credits.bat import wb-accounts.json`);
> 3. Edge 退出登录,换**账号 B** 重复第 1~2 步;
> 4. 全部导入完,点「刷新全部」/ `node wb-credits.mjs all`。

## CLI 命令速查

| 命令 | 作用 |
|---|---|
| `import <wb-accounts.json>` | 从 Edge 插件导出的文件导入/更新账号池(替代旧 save-current) |
| `accounts` | 列出账号池(显示名/手机号/Uin/状态) |
| `rename <序号\|id\|Uin> <显示名>` | 设置显示名称(仅展示,不改底层数据) |
| `del <序号\|id\|Uin>` | 删除账号 |
| `all [--csv 路径]` | 批量查询全部账号(汇总表 / CSV) |
| `[--account <序号\|id\|Uin>] [--json\|--csv 路径]` | 单账号查询 |

## 数据与隐私

- `wb-accounts.json` 含**所有账号登录凭证**,仅存本机,**严禁外传/上传**;仓库已 gitignore
- 数据真相源为 `credits.db`(SQLite,账号 + 时序快照),`wb-*.json` 仅作 WebDAV 迁移桥接
- 备份/迁移用 GUI「☁️ 云同步」→「🔄 一键同步」(拉取合并 + 上传全量,存到你的 WebDAV)
- 查询不依赖浏览器,仅需网络直连 `www.workbuddy.cn`

## 迁移与重新打包（2026-08-16 v1.4.62 实测事故复盘）

> **v1.4.65 起**:CDP 调试浏览器采集(edge-daemon)已**移除并归档**,下方第 2 项与「调试 Edge 启动姿势」仅**历史参考**;凭证更新统一走 **Edge 插件导出 → 「导入账号信息」**。

> **为什么"重新打包后无法正常使用"?** 根因只有一个:打包/迁移时把**开发机环境**硬编码带进了产物。新包在新机器上必须过一遍下面的检查清单,否则大概率踩坑。

### 必查清单(重新打包 / 换机器后逐项核对)

| # | 检查项 | 症状 | 处置 |
|---|---|---|---|
| 1 | **UA 是否被官方风控**(最常见) | 添加凭证/查询全部 401,换账号重登无效 | 见下方「UA 风控」,实测当前放行值后改 `src/config.js` |
| 2 | `edge-daemon.mjs` 是否硬编码了打包机路径 | 旧包(≤v1.4.62)的 `USER_DATA` 写过 `C:\Users\2504\...`,换机器即失效 | **已归档(v1.4.65 弃用 CDP 采集)**,无需再查;历史包可 `grep USER_DATA legacy/edge-daemon.mjs` |
| 3 | `.bat` 的 Node 探测是否命中 | 双击窗口报 `Node.js not found` / 一闪而过 | `where node` 失败会回退 `%USERPROFILE%\.workbuddy\binaries\node\...`;该变量在部分启动器上下文不展开,且无 WorkBuddy 托管 Node 的机器需自装 Node 22+ |
| 4 | **桌面采集的调试 Edge 是否启动** | GUI 显示"浏览器代理未连接";添加凭证失败 | 见下方「调试 Edge 启动姿势」;日常 Edge 登录**无效** |

### UA 风控(2026-08-16 实测)

`billing/meter/get-user-resource` 接口有 UA 风控,只放行特定 `Edg/xx.0.0.0` 占位版本。本次事故:**工具硬编码 `Edg/148.0.0.0` 已落后,被 APISIX 网关 401 拦截**(页面浏览器请求正常、工具进程全部 401);实测仅 `Edg/151.0.0.0` 稳定放行(148/150/151 精确版本均 401)。官方前端每次升级都可能导致放行值变化,排查与实测方法见 [`docs/问题记录/官方UA风控致添加凭证401.md`](docs/问题记录/官方UA风控致添加凭证401.md)。**全部账号突然集体 401 时,优先怀疑此项。**

### 调试 Edge 启动姿势(已废弃,v1.4.65 移除 CDP 采集,仅历史参考)

```bat
"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" --remote-debugging-port=9222 --user-data-dir="<工具目录>\edge-debug-profile" https://www.workbuddy.cn
```

- 必须用**独立 profile**(`edge-debug-profile`),不能与日常 Edge 共用;daemon 3 秒轮询自动连接
- 采集/添加凭证读的是**这个调试实例**的登录态——日常 Edge 登录无效,凭证添加失败先查这个窗口
- 调试实例被关闭 → daemon 掉线 → GUI 报"浏览器代理未连接",重新执行上面命令即恢复
- 凭证有固定有效期,到期后重新走 **Edge 插件「抓取当前账号」→ 导出 → 导入** 更新凭证

### 迁移到新机器(数据 + 环境)

1. 整个工具目录拷贝即可(含 `credits.db` / `wb-*.json`),数据零迁移成本
2. 双击 `.bat` 验证 Node 探测(见清单 #3)
3. 账号采集装 Edge 插件 `extensions/wb-credits-capture/`(见「首次使用」)
4. 用 `node wb-credits.mjs accounts` 确认账号池在;凭证过期则重新走 插件导出 → `import` 更新
5. 实测 UA 放行值(方法见问题记录),必要时更新 `src/config.js`

## 平台托管说明（tool.json 能力声明）

- 本工具**未声明 `capabilities`**(无「💾 存储」等能力徽标),数据直接写在工具目录,通过 **`dataFiles`** 声明保护:平台按 glob(`*.db`、`*.db-wal`、`*.db-shm`、`wb-*.json`、`data/**`)识别这些为"数据",**升级工具时保留不被覆盖**
- `dataFiles` vs `capabilities:["storage"]` 两种数据保护方案二选一即可:前者数据留工具目录、按 glob 识别保留;后者数据放平台数据区(`CAP_STORAGE_DIR`)、平台兜底备份。本工具选 `dataFiles`(数据文件多、结构自定义,且 WebDAV 备份已自管)
- 平台顶部能力筛选 Tab 仅当能力种类 ≥2 时显示(tools-center v0.12.5 起单能力自动隐藏),与分类(本工具 `group:"监控"`)互不影响

## 开发与测试

```bash
npm test            # 回归测试(12 个文件:管理员流程/历史导入/趋势渲染/路由冒烟/消耗口径/固化/签到/调度/WebDAV/采集)
node --check wb-gui.mjs   # 语法校验
```

架构细节见 [`docs/架构.md`](docs/架构.md);部署见 [`docs/部署.md`](docs/部署.md)。

## 文档索引

| 文档 | 给谁看 | 内容 |
|---|---|---|
| [`AGENTS.md`](AGENTS.md) | AI / 未来的你 | 技术栈、关键坑、约定、常用命令 |
| [`CHANGELOG.md`](CHANGELOG.md) | 所有人 | 版本变更记录(v1.4.2 起为 SQLite/统一采样/7 文件前端时代) |
| [`docs/架构.md`](docs/架构.md) | 开发者 | 完整模块架构、数据流、维护指南 |
| [`docs/部署.md`](docs/部署.md) | 运维 | 桌面 / Docker 两种部署方案 |
| [`docs/tools-center部署.md`](docs/tools-center部署.md) | 运维 | **平台版标注**:tools-center 托管接入规范(目录/tool.json/数据/升级) |
| [`docs/发布规范.md`](docs/发布规范.md) | 维护者 | **发包要求**:平台版 + Edge 插件版(维护),bat 版随版本自然迭代不专门测试;版本 bump/发布步骤/铁律 |
| [`docs/交接说明.md`](docs/交接说明.md) | 接手者 | 快速上手与状态快照 |
| [`docs/问题记录/`](docs/问题记录/) | 开发者 | 踩坑与解决(一坑一篇) |
| [`extensions/wb-credits-capture/`](extensions/wb-credits-capture/) | 维护者/用户 | **配套抓取扩展(免调试浏览器)**:日常 Edge 登录 → 抓取 Cookie → WebDAV 同步 → 工具「一键同步」导入。**本仓库同时维护此插件,改工具采集链路时需同步** |

## 免责声明

本项目调用 WorkBuddy **内部接口**(无公开文档),官方前端改版可能导致字段/地址变化,需同步更新 `src/compute/client.js`。仅用于个人积分管理,请勿用于商业用途或高频抓取。
