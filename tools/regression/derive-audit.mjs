// tools/regression/derive-audit.mjs - 派生口径快照巡检（只读，不改数据）
//
// 对账号池（或指定账号）跑一遍 deriveAll 的唯一派生源 deriveAccount，打印当前口径快照，
// 用于"肉眼看某账号的剩余/累计/今日消耗/今日到账对不对"——这是 test/ 之外的手工巡检入口。
// 一次性排查脚本(C:\Temp\wb_restore)不入库，本脚本是可移植的替代。
// 用法:
//   node tools/regression/derive-audit.mjs                 # 全部账号
//   node tools/regression/derive-audit.mjs <uin|名字>       # 只查某个账号
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const tool = fileURLToPath(new URL("../../", import.meta.url)); // 指向 trae-credits-tool 根目录
const { getDb } = await import(pathToFileURL(path.join(tool, "src/store/db.js")).href);
const { loadAccounts } = await import(pathToFileURL(path.join(tool, "src/compute/store.js")).href);
const { deriveAccount } = await import(pathToFileURL(path.join(tool, "src/compute/derive.js")).href);

getDb(); // 初始化 DB（默认 TOOLS_DIR 即工具根）

const want = process.argv[2];
const accounts = loadAccounts().filter(
  (a) => !want || a.uin === want || a.name === want || a.displayName === want
);
if (!accounts.length) {
  console.error(want ? `未找到匹配账号: ${want}` : "账号池为空");
  process.exit(1);
}

const pad = (s, n) => String(s).padStart(n);
console.log(
  `${"uin(前10)".padEnd(12)}${"来源".padEnd(8)}${"名字".padEnd(18)}${"剩余".padStart(8)}` +
    `${"累计已用".padStart(9)}${"今日消耗".padStart(7)}${"今日到账".padStart(7)}${"签到".padEnd(4)}快照`
);
for (const a of accounts) {
  const d = deriveAccount(a.uin, a); // a 为完整账号(含 appKey)，派生会按软件源计价
  const r2 = (v) => (Number.isFinite(v) ? Math.round(v * 100) / 100 : v);
  console.log(
    `${(a.uin || "").slice(0, 10).padEnd(12)}` +
      `${(a.appKey || "?").padEnd(8)}` +
      `${(a.displayName || a.name || a.uin || "").padEnd(18)}` +
      `${pad(r2(d.currentRemain), 8)}${pad(r2(d.consumed), 9)}${pad(r2(d.todayUsed), 7)}${pad(r2(d.todayAdded), 7)}` +
      `${d.signedInToday ? "✓  " : "—  "}${d.points}`
  );
}