// test/history-import.test.mjs — 时序导入回归（v1.4.6 双 bug：清空覆盖 + 时间戳/去重错误）
// 运行: node test/history-import.test.mjs
// 隔离方式: 复制 src/ 到系统临时目录运行(TOOLS_DIR 指向临时目录,绝不触碰真实 credits.db)。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const sleep = () => new Promise((r) => setTimeout(r, 10));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wb-hist-test-"));
fs.cpSync(path.join(ROOT, "src"), path.join(tmp, "src"), { recursive: true });

let passed = 0, failed = 0;
const assert = (n, c, x = "") => { if (c) { passed++; console.log("  PASS " + n); } else { failed++; console.log("  FAIL " + n + (x ? "  << " + x : "")); } };

try {
  const { getDb } = await import("file:///" + tmp.replace(/\\/g, "/") + "/src/store/db.js");
  const hist = await import("file:///" + tmp.replace(/\\/g, "/") + "/src/compute/history.js");

  const mk = (ts, rem) => ({ uin: "u1", ts, baseRemain: rem, baseUsed: 0, giftRemain: 0, giftUsed: 0, summary: { baseRemain: rem } });
  // 本地已存在: 今天两条快照(基线 800 → 760, 今日已用 40)
  hist.appendSnapshot([mk("2026-08-04T01:00:00.000Z", 800)], { ts: "2026-08-04T01:00:00.000Z" });
  hist.appendSnapshot([mk("2026-08-04T04:00:00.000Z", 760)], { ts: "2026-08-04T04:00:00.000Z" });

  console.log("T1 importLegacy 合并导入(不清空本地)");
  const cloud = [
    { ts: "2026-08-03T01:00:00.000Z", entries: [mk("2026-08-03T01:00:00.000Z", 900)] },
    { ts: "2026-08-03T05:00:00.000Z", entries: [mk("2026-08-03T05:00:00.000Z", 850)] },
    { ts: "2026-08-03T09:00:00.000Z", entries: [mk("2026-08-03T09:00:00.000Z", 820)] },
    { ts: "2026-08-04T00:00:00.000Z", entries: [mk("2026-08-04T00:00:00.000Z", 810)] },
  ];
  fs.writeFileSync(path.join(tmp, "wb-history.json"), JSON.stringify({ snapshots: cloud }));
  hist.importLegacy();
  const db = getDb();
  const rows = db.prepare("SELECT ts FROM readings ORDER BY ts ASC").all();
  assert("本地今天的快照被保留", rows.some((r) => r.ts.startsWith("2026-08-04T01:00")));
  assert("导入的历史按原始 ts 全部落盘(昨天 3 条)", rows.filter((r) => r.ts.startsWith("2026-08-03")).length === 3);
  assert("导入今天 08:00 快照", rows.some((r) => r.ts.startsWith("2026-08-04T00:00")));
  assert("总行数 = 2 本地 + 4 导入 = 6", rows.length === 6, "got " + rows.length);

  console.log("T2 重复导入去重(基于快照自身 ts)");
  hist.importLegacy();
  const n2 = db.prepare("SELECT COUNT(*) c FROM readings").get().c;
  assert("重复导入不新增行", n2 === 6, "got " + n2);

  console.log("T3 今日已用基线(自然日)");
  const all = db.prepare("SELECT ts, raw FROM readings WHERE uin='u1' ORDER BY ts ASC").all();
  const today0 = new Date("2026-08-04T00:00:00.000Z").getTime();
  const todayRows = all.filter((r) => new Date(r.ts).getTime() >= today0);
  assert("今天有快照(基线不丢)", todayRows.length >= 3, "got " + todayRows.length);
  const baseline = JSON.parse(todayRows[0].raw).baseRemain;
  const latest = JSON.parse(todayRows[todayRows.length - 1].raw).baseRemain;
  assert("今日已用 = 基线 - 当前 = 50", Math.max(0, baseline - latest) === 50, `baseline=${baseline} latest=${latest}`);
  await sleep();

  console.log("T4 无 ts 旧格式兜底");
  fs.writeFileSync(path.join(tmp, "wb-history.json"), JSON.stringify({ snapshots: [{ entries: [mk("2026-08-01T00:00:00.000Z", 950)] }] }));
  hist.importLegacy();
  const n4 = db.prepare("SELECT COUNT(*) c FROM readings").get().c;
  assert("无 ts 兜底导入不崩溃", n4 >= 7, "got " + n4);

  console.log("T5 已固化旧日快照跳过(防陈旧镜像重新灌满数据库)");
  hist.saveDaySummary("u1", "2026-08-03", 80, 900, 820, 1); // 模拟 08-03 已固化
  const cloud2 = {
    summaries: [{ uin: "u1", day: "2026-08-03", used: 80, startRemain: 900, endRemain: 820, signedIn: 1 }],
    snapshots: [
      { ts: "2026-08-03T01:00:00.000Z", entries: [mk("2026-08-03T01:00:00.000Z", 900)] },
      { ts: "2026-08-03T05:00:00.000Z", entries: [mk("2026-08-03T05:00:00.000Z", 850)] },
      { ts: "2026-08-04T06:00:00.000Z", entries: [mk("2026-08-04T06:00:00.000Z", 700)] },
    ],
  };
  fs.writeFileSync(path.join(tmp, "wb-history.json"), JSON.stringify(cloud2));
  const before5 = db.prepare("SELECT COUNT(*) c FROM readings").get().c;
  hist.importLegacy();
  const n5 = db.prepare("SELECT COUNT(*) c FROM readings").get().c;
  assert("08-03 已固化快照被跳过(只新增 08-04 一条)", n5 === before5 + 1, `before=${before5} after=${n5}`);
  assert("08-04 未固化快照被导入", db.prepare("SELECT COUNT(*) c FROM readings WHERE ts LIKE '2026-08-04T06%'").get().c === 1);
  assert("08-03 未新增快照", db.prepare("SELECT COUNT(*) c FROM readings WHERE ts LIKE '2026-08-03T%'").get().c === 3, "got " + db.prepare("SELECT COUNT(*) c FROM readings WHERE ts LIKE '2026-08-03T%'").get().c);
} catch (e) {
  console.log("  FAIL 测试执行异常: " + e.message);
  failed++;
} finally {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
}

console.log(`\n===== ${passed} passed, ${failed} failed =====`);
process.exit(failed ? 1 : 0);
