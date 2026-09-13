# TRAE Work 积分工具

## 平台版（tools-center）

| 项 | 值 |
|---|---|
| 工具 id | `trae-credits` |
| 平台端口 | **8133** |
| 健康检查 | `/api/status` |
| 访问地址 | `http://<平台地址>/tool/trae-credits/` |

> ⚠️ **端口由 [tools-center](https://github.com/Simiely/tools-center) 统一分配**，
> 登记表见 [`docs/ports.md`](https://github.com/Simiely/tools-center/blob/main/docs/ports.md)。
> **改端口前必须先查登记表**，改完同步更新登记表与仓库内所有声明文件（`tool.json` 的 `cmd` 数组末位与 `port` 字段两处必须一起改）。

TRAE Work（TRAE SOLO CN）账号积分采集与仪表盘工具，提供命令行（CLI）与本地网页仪表盘（GUI）两种入口。
多账号直接解密本机 TRAE 登录态（含 MultiSwitch 槽备份）取 JWT，调用 TRAE 官方接口（api.trae.cn），无需浏览器插件。

> 复刻自 `Simiely/workbuddy-credits-tool`（WorkBuddy 版）的完整架构，改造数据源为 TRAE。Node ≥ 18，零第三方依赖。

## 功能特性

- **多来源账号池：TRAE + WorkBuddy（CodeBuddy）混合支持**。`scan` 同时扫描本机 TRAE 登录态、WorkBuddy `.info` 登录态，以及 MultiSwitch（登录态切换器）的**槽备份**——TRAE 槽（`backups/trae/<槽>/…storage.json`）与 WorkBuddy 槽（`backups/workbuddy/<槽>/…info`）。每槽各取一个最新 `.info`（切换器会保留历史备份快照，工具自动去重到最新）。
- **双源积分采集**：TRAE 走 `api.trae.cn` entitlement（官方总池口径）；**WorkBuddy 走 `get-user-resource`**（`www`/`copilot` 域的 `/v2/billing/meter/get-user-resource`，Bearer 认证 + UA 防风控），同样产出「总剩余/已用/各积分包/到期时间」，与 TRAE 共用同一套快照/趋势/到期派生。
- **多账号池**：自动发现本机登录态 + MultiSwitch 槽备份，每个账号独立解析登录态，批量查询单账号失败不影响其他
- **总积分**：通用积分池总量 / 已用 / 可用剩余（usage_summary 官方口径）
- **各积分包明细**：来源（老用户福利/签到/邀请/每月登录…）、已用/总量、剩余、过期时间（按包列出）
- **到期统计**：近 1/2/3/7 天过期积分、周桶到期柱图、排序紧迫度
- **今日签到**：实时 checkin 接口（`checked_in`/连签/奖励），固化进快照
- **消耗趋势**：SQLite 时序快照 → 每日消耗（usage_summary 快照差值）→ 趋势柱状图
- **GUI 仪表盘**：深色主题、总剩余大数字 → 消耗趋势 → 账号卡片（剩余/积分包/签到/过期）
- **本地缓存**：最近一次结果落盘，断网可看
- **多来源导入**：扫描本机登录态/槽，或直接导入 MultiSwitch「🔑导出凭证」json（内联 token，自包含可跨机）
- **WebDAV 云同步**（可选）：账号池 + 历史镜像双向同步，跨设备（默认目录 `workbuddy/workbuddy登录积分/trae积分`）
- **CLI**：`scan` / `import` / `accounts` / `rename` / `del` / `all` / 单账号 / `report`

## 快速开始

> 依赖：Node.js ≥ 18，零第三方依赖。多账号时需本机已登录多个 TRAE 账号或有多账号槽备份。

### 方式一：GUI 仪表盘（推荐）

```bash
node trae-gui.mjs        # 或 Windows 可双击
# 自动打开 http://127.0.0.1:8080（端口被占自动顺延）
```

### 方式二：命令行

```bash
node trae-credits.mjs scan          # 扫描本机 TRAE 登录态 + MultiSwitch 槽 → 建立账号池
node trae-credits.mjs accounts      # 查看账号池
node trae-credits.mjs all           # 一键批量查询全部账号
node trae-credits.mjs --account=1   # 查询单个账号明细
```

### 首次使用：建立账号池

账号池有两种建法，按需选一：

**① 扫描本机登录态/槽（需本机已登录 TRAE）**
1. 确保本机 TRAE SOLO CN 已登录（`%APPDATA%\TRAE SOLO CN\User\globalStorage\storage.json` 存在）。
2. 若有多账号，把 MultiSwitch 的槽备份目录指向 `登录态切换器\backups\trae\<槽>`（工具默认探测该路径），或设环境变量 `TRAE_SLOT_ROOT` 指向槽根目录。
3. 运行 `node trae-credits.mjs scan`（或 GUI「📥 导入凭证/账号」选扫描）→ 解密各登录态 → 建立账号池。
4. 点「刷新全部」/ `node trae-credits.mjs all`。

**② 导入 MultiSwitch「🔑导出凭证」的 json（本机无需登录/解密）**
- 用 MultiSwitch（登录态切换器）「🔑导出凭证」把某账号 token 导出为 json，然后 GUI「📥 导入凭证/账号」选该文件，或 `node trae-credits.mjs import <导出的.json>` → 直接建立可联网查积分的账号（`source=ms-export`）。
- 该凭证为**内联 token**（含 token/expiredAt 等），自包含、可经 WebDAV 云同步带到其它机器仍能查，比「路径型(引用本机 storage.json)」更可移植。

## CLI 命令速查

| 命令 | 作用 |
|---|---|
| `scan` | 扫描本机 TRAE 登录态 + 槽 → 建立/更新账号池 |
| `import <file.json>` | 导入账号池：本工具导出的 `trae-accounts.json` **或** MultiSwitch「🔑导出凭证」json（自动识别两种格式） |
| `accounts` | 列出账号池（显示名/用户名/Uin/状态/来源） |
| `rename <序号\|id\|Uin> <显示名>` | 设置显示名称 |
| `del <序号\|id\|Uin>` | 删除账号 |
| `all [--csv 路径]` | 批量查询全部账号 |
| `report` | 派生视图（剩余/今日已用/累计/趋势） |
| `[--account <序号\|id\|Uin>] [--json\|csv]` | 单账号查询 |

## 数据与隐私

- 账号凭据分**两种形态**：
  - **路径型**（扫描本机/槽所得）：`cookieHeader` 存 storage.json 路径，**解密只在查询瞬间进行，token 不落盘明文**；
  - **内联型**（导入 MultiSwitch「🔑导出凭证」所得，`source=ms-export`）：`cookieHeader` 存完整 json（含 token/expiredAt），自包含、可经 WebDAV 同步跨机，但 token 明文存在本机账号池（仍**严禁外传/上传**）。
- `trae-accounts.json` / `credits.db` 含账号登录态引用，仅存本机，**严禁外传/上传**（仓库已 gitignore）。
- 数据真相源为 `credits.db`（SQLite，账号 + 时序快照）。
- 查询不依赖浏览器，仅需网络直连 `api.trae.cn`。

## 架构

```
        ┌─ 发现 / 采集（只读、零消耗接口）──────────────────────────────┐
        │  scan 解密本机/槽登录态 → query / derive / model              │
        │    TRAE(api.trae.cn)  +  WorkBuddy(get-user-resource)        ｜
        └──────────────────────────────┬──────────────────────────────┘
                                       ▼
        ┌─ 采样落盘 · sample.sampleAll（唯一采集入口）─────────────────┐
        │  history.appendSnapshot → readings（append-only，真源表）    │
        └──────────────────────────────┬──────────────────────────────┘
                                       ▼
        ┌─ 派生 · derive.deriveAll（唯一派生源，CLI/GUI 共用）────────┐
        │  currentRemain / 消耗(格式感知) / 今日到账(login 100|150)    │
        │  赠送包到期 / todayAdded                                     │
        └──────────────┬──────────────────────────┬───────────────────┘
                       ▼                          ▼
        ┌─ 展示 ───────────────┐   ┌─ 固化 · gc.gcDaySummaries ─────────┐
        │ present / wb-gui.*   │   │  日汇总(T-2 只留 used)              │
        │ CLI tbl + HTML 仪表盘 │   │  清理 T-2 之前的旧快照明细          │
        └──────────────────────┘   └────────────────────────────────────┘

        支线：WebDAV 云同步 / 定时签到（checkin）
              文件清单真源统一收敛到 store/syncbridge.js（ACCOUNTS/HISTORY）
```

- **单一真源**：`readings` 表 append-only；所有派生集中在 `deriveAll`，CLI/GUI/明细都消费它。
- **单采集入口**：`/api/all` 与调度器统一走 `sample.sampleAll`，不再各采一套。
- **分层单向、无循环依赖**：`config/time/domain`(纯净) → `store`(IO) → `compute`(逻辑) → `present`(展示)；曾因 `gc` 独立成模块解除了 derive↔history 互引。
- **口径不变量**（`test/` 回归保护，改口径必跑 `npm test`）：日消耗正增量累加、今日到账按来源 `SIGNIN_CREDIT`(workbuddy=100 / traework=150)、固化窗口(T-2)、同步幂等、凭据文件必须被 `.gitignore` 覆盖。

## 开发与测试

```bash
node --check trae-gui.mjs trae-credits.mjs   # 语法校验
npm test                                     # 回归测试（口径/同步/鉴扫）
```

## 与 WorkBuddy 版的差异

| 维度 | WorkBuddy 版 | 本 TRAE 版 |
|---|---|---|
| 采集 | Edge 插件抓 cookie | 解密本机 TRAE storage.json（tc 格式，AES-128-CBC） |
| 认证 | Cookie | `Authorization: Cloud-IDE-JWT <token>` |
| 接口 | billing/meter | user_current_entitlement_list + checkin_credits/status |
| 数据模型 | 体验版 base + 赠送包 | 通用积分池 + 各 entitlement 包（统一按池统计） |
| 签到 | 元数据推断 | 官方 checkin 接口 |

> 免责声明：本项目调用 TRAE 内部接口（无公开文档），官方改版可能变化。仅用于个人积分管理，勿高频抓取。tc 解密算法来源 kenuoseclab/trae-local-api（开源）。
