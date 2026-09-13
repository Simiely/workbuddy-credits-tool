# tools/regression - 口径回归与调试工具箱

记录本项目派生口径的**不变量**与排查入口，避免未来重复踩坑。
一次性数据修复脚本（`C:\Temp\wb_restore` 等临时目录）**不入库**——那是噪音，
真正的口径看护已由 `npm test`（`node --test`）承担，本目录只留方法与索引。

## 权威口径不变量（已由 test/ 锁定）

| 口径 | 判定来源 | 回归测试 | 不变量 |
|---|---|---|---|
| 日消耗 `todayUsed`/`dailyUsed` | `consumeByUsed()`（正增量累加） | `test/derive.test.mjs` | 签到重置/格式切换的基准跳变**不计**为消耗；baseUsed 同口径计入；2 位取整 |
| 今日到账 `todayAdded` | `todayAddedFrom()`（按 `config.SIGNIN_CREDIT`） | `test/derive.test.mjs` | workbuddy=100 / traework=150；未签到恒 0 |
| 历史固化 `gcDaySummaries` | T-2 及更早固化为摘要并删明细 | `test/db.derive.test.mjs` | 只保留昨天/今天明细；摘要幂等；旧明细必被清理 |
| 派生全链路 | `deriveAccount()`（真实 SQLite） | `test/db.derive.test.mjs` | 今日快照区间、签到、累计消耗 |
| 同步桥接幂等 | export→import 往返 | `test/syncbridge.test.mjs` | 账号/历史重复导入不重复；镜像清空后能完整恢复 |
| 文件清单真源 | `src/store/syncbridge.js` | `test/syncbridge.test.mjs` | `SYNC_FILES` 与 `ACCOUNTS_FILE`/`HISTORY_FILE` 一致 |

> 若要改动上述任一口径（签到奖励、格式判定、固化窗口、双写桥接），**必须先跑通 `npm test`**，
> 再改实现——这就是把它们从"手工抓时序"升级为"可回归"的方式。

## 常见问题排查入口

- **"某账号日消耗/到账看着不对"** → `npm test` 先看是否被打红；若红，说明口径被改动了。
  排查脚本思路（临时）：读 `readings` 按 uin 出 `giftUsed`/`signedIn` 时间序列，比对 `consumeByUsed` 判定。
- **"云同步后数据多了/少了"** → 对起到 `test/syncbridge.test.mjs` 的往返语义；
  检查 `trae-accounts.json` / `trae-history.json` 是否与 SQLite 一致。
- **"旧格式/新格式混在一起"** → `historyFor()` 的 `unified` 标记（`raw` 是否含 `giftPackages`）。

## 已收拢的可移植脚本

一次性排查脚本（`C:\Temp\wb_restore` 等）**不入库**（硬编码本机绝对路径与具体 uin/日期，是无法复用的噪音）。改用下面两个**参数化、相对定位工具根**的入口，任何机器/时间可复跑：

| 脚本 | 作用 | 用法 |
|---|---|---|
| `derive-audit.mjs` | 对账号池/指定账号跑唯一派生源 `deriveAccount`，打印 剩余/累计/今日消耗/今日到账/签到/快照数 | `node tools/regression/derive-audit.mjs [uin|名字]` |
| `readings-seq.mjs` | 打印某账号原始快照时序(giftUsed/remain/signedIn/unified/size)，核对某天怎么算的 | `node tools/regression/readings-seq.mjs <uin> [起始ts]` |

> 二者只读，不改数据；若要排查口径 diff，`npm test` 是先手，这两个脚本是后手（看实际数值）。