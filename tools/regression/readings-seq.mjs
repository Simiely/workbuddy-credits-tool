// tools/regression/readings-seq.mjs - 某账号快照原始时序（只读）
//
// 打印指定账号的 readngs 时间序列（giftUsed/giftRemain/signedIn/unified/size），
// 用于手工核对"某天的消耗/签到怎么算出来的"，与 derive-audit 配合做巡检。
// 一次性排查脚本不入库，本脚本是可移植的替代（相对定位工具根，参数化，不硬编码 uin/日期）。
// 用法:
//   node tools/regression/readings-seq.mjs <uin> [起始ts]
//     起始ts 形如 2026-09-09 或 2026-09-09T00:00；省略则从最早一条打印。
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const tool = fileURLToPath(new URL("../../", import.meta.url)); // 指向 trae-credits-tool 根目录
const { getDb } = await import(pathToFileURL(path.join(tool, "src/store/db.js")).href);
const db = getDb();

const uin = process.argv[2];
if (!uin) {
  console.error("用法: node tools/regression/readings-seq.mjs <uin> [起始ts]");
  process.exit(1);
}
const since = process.argv[3] || "";
const rows = since
  ? db.prepare("SELECT ts, giftUsed, giftRemain, raw FROM readings WHERE uin=? AND ts>=? ORDER BY ts ASC").all(uin, since)
  : db.prepare("SELECT ts, giftUsed, giftRemain, raw FROM readings WHERE uin=? ORDER BY ts ASC").all(uin);

if (!rows.length) {
  console.log(`(无 readings，uin=${uin}${since ? ` since=${since}` : ""})`);
  process.exit(0);
}

for (const r of rows) {
  let m = {};
  try { m = JSON.parse(r.raw || "{}"); } catch {}
  const unified = Object.prototype.hasOwnProperty.call(m, "giftPackages") ? "Y" : "N";
  console.log(
    `${r.ts.slice(0, 16)}  giftUsed=${String(r.giftUsed).padStart(6)}  giftRemain=${String(r.giftRemain).padStart(6)}  ` +
      `signedIn=${m.signedIn ?? "?"}  unified=${unified}  size=${m.giftSize ?? "?"}`
  );
}