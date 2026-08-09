// test/gc-summary.test.mjs — 历史固化回归（v1.4.31 规划落地）
// 场景:把 T-2 及更早的每日快照压缩为 day_summary 摘要后清理明细;
//       派生层双源读取(摘要+快照),固化前后展示值必须一致;备份镜像含摘要可完整恢复。
// 运行: node test/gc-summary.test.mjs    （run-all.mjs 自动纳入）
// 隔离方式: 复制 src/ 到系统临时目录(TOOLS_DIR 指向临时目录,绝不触碰真实 credits.db)。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wb-gc-test-"));
fs.cpSync(path.join(ROOT, "src"), path.join(tmp, "src"), { recursive: true });

let passed = 0, failed = 0;
const assert = (n, c, x = "") => { if (c) { passed++; console.log("  PASS " + n); } else { failed++; console.log("  FAIL " + n + (x ? "  << " + x : "")); } };

const TZ_MS = 8 * 3600 * 1000;
const cnDateOf = (utcMs) => new Date(utcMs + TZ_MS).toISOString().slice(0, 10);
const todayKey = cnDateOf(Date.now());
const dayStartUtc = (key) => new Date(key + "T00:00:00Z").getTime() - TZ_MS;
const yesterdayKey = cnDateOf(dayStartUtc(todayKey) - 86400000);
const dayBeforeKey = cnDateOf(dayStartUtc(todayKey) - 2 * 86400000);
const at = (key, hour) => new Date(dayStartUtc(key) + hour * 3600 * 1000).toISOString();

const mk = (ts, gR, gU) => ({ uin: "u1", ts, baseRemain: 500, baseUsed: 0, giftRemain: gR, giftUsed: gU, summary: { baseRemain: 500, baseUsed: 0, giftRemain: gR, giftUsed: gU } });

try {
  const { getDb } = await import("file:///" + tmp.replace(/\\/g, "/") + "/src/store/db.js");
  const hist = await import("file:///" + tmp.replace(/\\/g, "/") + "/src/compute/history.js");
  const derive = await import("file:///" + tmp.replace(/\\/g, "/") + "/src/compute/derive.js");
  const gc = await import("file:///" + tmp.replace(/\\/g, "/") + "/src/compute/gc.js"); // v1.4.58 固化独立模块
  const { getDb: getDb2 } = await import("file:///" + tmp.replace(/\\/g, "/") + "/src/store/db.js");

  // 构造:前天 2 条(消耗 30) + 昨天 2 条(消耗 30) + 今天 2 条(消耗 40)
  hist.appendSnapshot([mk(at(dayBeforeKey, 1), 3300, 100)], { ts: at(dayBeforeKey, 1) });
  hist.appendSnapshot([mk(at(dayBeforeKey, 8), 3270, 130)], { ts: at(dayBeforeKey, 8) });
  hist.appendSnapshot([mk(at(yesterdayKey, 1), 3240, 130)], { ts: at(yesterdayKey, 1) });
  hist.appendSnapshot([mk(at(yesterdayKey, 8), 3210, 160)], { ts: at(yesterdayKey, 8) });
  hist.appendSnapshot([mk(at(todayKey, 1), 3180, 160)], { ts: at(todayKey, 1) });
  hist.appendSnapshot([mk(at(todayKey, 8), 3140, 200)], { ts: at(todayKey, 8) });
  const db = getDb();
  assert("初始快照 6 条", db.prepare("SELECT COUNT(*) c FROM readings").get().c === 6);

  console.log("T1 固化前派生值(基线)");
  let d = derive.deriveAccount("u1");
  const before = d.dailyUsed.map((x) => x.day + ":" + x.used).join(",");
  assert("三天消耗 前天30/昨天30/今天40", before.includes(dayBeforeKey + ":30") && before.includes(yesterdayKey + ":30") && before.includes(todayKey + ":40"), "got " + before);

  console.log("T2 固化(T-2 前天)");
  const g1 = gc.gcDaySummaries();
  assert("固化 1 天", g1.fixed === 1, "got " + g1.fixed);
  const s1 = hist.loadDaySummaries("u1");
  assert("摘要表含前天", s1.some((x) => x.day === dayBeforeKey && x.used === 30));
  const rowsAfter = db.prepare("SELECT COUNT(*) c FROM readings").get().c;
  assert("前天快照已删(剩 4 条:昨+今)", rowsAfter === 4, "got " + rowsAfter);

  console.log("T3 固化后派生值不变(摘要补齐)");
  d = derive.deriveAccount("u1");
  const after = d.dailyUsed.map((x) => x.day + ":" + x.used).join(",");
  assert("固化后 dailyUsed 与固化前一致", after === before, "\n  before=" + before + "\n  after =" + after);
  assert("todayUsed 不变(40)", d.todayUsed === 40, "got " + d.todayUsed);

  console.log("T4 固化幂等(再跑一次)");
  const g2 = gc.gcDaySummaries();
  assert("第二次 fixed=0", g2.fixed === 0, "got " + g2.fixed);
  const s2 = hist.loadDaySummaries("u1");
  assert("摘要不重复(仍 1 行)", s2.length === 1, "got " + s2.length);

  console.log("T5 备份镜像含摘要 + 恢复可重建");
  hist.exportLegacy();
  const mirror = JSON.parse(fs.readFileSync(path.join(tmp, "wb-history.json"), "utf8"));
  assert("镜像含 snapshots(近期 4 条)", mirror.snapshots.length === 4, "got " + mirror.snapshots.length);
  assert("镜像含 summaries(固化 1 条)", Array.isArray(mirror.summaries) && mirror.summaries.length === 1);
  // 新库恢复
  const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), "wb-gc-restore-"));
  fs.cpSync(path.join(ROOT, "src"), path.join(tmp2, "src"), { recursive: true });
  const hist2 = await import("file:///" + tmp2.replace(/\\/g, "/") + "/src/compute/history.js");
  const derive2 = await import("file:///" + tmp2.replace(/\\/g, "/") + "/src/compute/derive.js");
  fs.copyFileSync(path.join(tmp, "wb-history.json"), path.join(tmp2, "wb-history.json"));
  hist2.importLegacy();
  const d2 = derive2.deriveAccount("u1");
  const restored = d2.dailyUsed.map((x) => x.day + ":" + x.used).join(",");
  assert("恢复库派生一致(含摘要补齐)", restored === before, "\n  before  =" + before + "\n  restored=" + restored);
} catch (e) {
  console.log("  FAIL 测试执行异常: " + e.message);
  failed++;
}

console.log(`\n========== gc-summary: ${passed} 通过 / ${failed} 失败 ==========`);
process.exit(failed ? 1 : 0);
