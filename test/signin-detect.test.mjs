// test/signin-detect.test.mjs — 签到检测回归（v1.4.33）
// 原理:签到 = 今日新增「到期日 = 今天+1自然月(对日)」的赠送包。
// 运行: node test/signin-detect.test.mjs    （run-all.mjs 自动纳入）
// 隔离方式: 复制 src/ 到系统临时目录(绝不触碰真实 credits.db)。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wb-signin-test-"));
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
const addMonth = (key) => {
  const [y, m, d] = key.split("-").map(Number);
  const t = new Date(y, m, d);
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")}`;
};
const targetToday = addMonth(todayKey);
const targetYesterday = addMonth(yesterdayKey);

const pack = (end, remain, size = 100) => ({
  packageName: "CodeBuddy个人版国内运营",
  status: 0,
  capacityRemain: remain,
  capacityUsed: size - remain,
  capacitySize: size,
  cycleEndTime: end + "T12:00:00Z",
});
const mk = (uin, ts, gR, gU, packs) => ({
  uin, ts, baseRemain: 500, baseUsed: 0, giftRemain: gR, giftUsed: gU,
  giftPackages: packs,
  summary: { baseRemain: 500, baseUsed: 0, giftRemain: gR, giftUsed: gU },
});

try {
  const hist = await import("file:///" + tmp.replace(/\\/g, "/") + "/src/compute/history.js");
  const derive = await import("file:///" + tmp.replace(/\\/g, "/") + "/src/compute/derive.js");
  const gc = await import("file:///" + tmp.replace(/\\/g, "/") + "/src/compute/gc.js"); // v1.4.58 固化独立模块

  // 注意:appendSnapshot 同分钟去重全局不分账号,各场景时间必须互不相同
  console.log("T1 今天签到(首条无包,最新新增目标到期满额包) → true");
  hist.appendSnapshot([mk("u1", at(todayKey, 1.1), 1000, 0, [])], { ts: at(todayKey, 1.1) });
  hist.appendSnapshot([mk("u1", at(todayKey, 9.1), 1100, 0, [pack(targetToday, 100)])], { ts: at(todayKey, 9.1) });
  let d = derive.deriveAccount("u1");
  assert("signedInToday = true", d.signedInToday === true, "got " + d.signedInToday);

  console.log("T2 昨天签过、今天没签(只有昨天到期包) → false");
  hist.appendSnapshot([mk("u2", at(todayKey, 1.3), 1000, 0, [pack(targetYesterday, 100)])], { ts: at(todayKey, 1.3) });
  hist.appendSnapshot([mk("u2", at(todayKey, 9.3), 1000, 0, [pack(targetYesterday, 50)])], { ts: at(todayKey, 9.3) });
  d = derive.deriveAccount("u2");
  assert("signedInToday = false(昨天包对日不匹配)", d.signedInToday === false, "got " + d.signedInToday);

  console.log("T3 今天签到但包已消耗(70/100) → 仍 true");
  hist.appendSnapshot([mk("u3", at(todayKey, 1.5), 1000, 0, [])], { ts: at(todayKey, 1.5) });
  hist.appendSnapshot([mk("u3", at(todayKey, 9.5), 1070, 30, [pack(targetToday, 70)])], { ts: at(todayKey, 9.5) });
  d = derive.deriveAccount("u3");
  assert("signedInToday = true(不要求满额)", d.signedInToday === true, "got " + d.signedInToday);

  console.log("T4 完全没有目标包 → false");
  hist.appendSnapshot([mk("u4", at(todayKey, 1.7), 1000, 0, [])], { ts: at(todayKey, 1.7) });
  hist.appendSnapshot([mk("u4", at(todayKey, 9.7), 1000, 0, [pack(targetYesterday, 100)])], { ts: at(todayKey, 9.7) });
  d = derive.deriveAccount("u4");
  assert("signedInToday = false", d.signedInToday === false, "got " + d.signedInToday);

  console.log("T5 首条已有同到期日包(非今日新增) → false");
  hist.appendSnapshot([mk("u5", at(todayKey, 1.9), 1100, 0, [pack(targetToday, 100)])], { ts: at(todayKey, 1.9) });
  hist.appendSnapshot([mk("u5", at(todayKey, 9.9), 1100, 0, [pack(targetToday, 100)])], { ts: at(todayKey, 9.9) });
  d = derive.deriveAccount("u5");
  assert("signedInToday = false(首条已存在)", d.signedInToday === false, "got " + d.signedInToday);

  console.log("T6 固化摘要记录签到状态(历史回查)");
  hist.appendSnapshot([mk("u6", at(dayBeforeKey, 1.2), 1000, 0, [])], { ts: at(dayBeforeKey, 1.2) });
  hist.appendSnapshot([mk("u6", at(dayBeforeKey, 9.2), 1100, 0, [pack(addMonth(dayBeforeKey), 100)])], { ts: at(dayBeforeKey, 9.2) });
  hist.appendSnapshot([mk("u6", at(todayKey, 1.4), 1100, 0, [pack(addMonth(dayBeforeKey), 80)])], { ts: at(todayKey, 1.4) });
  const g = gc.gcDaySummaries();
  assert("固化执行", g.fixed >= 1, "got " + g.fixed);
  const summ = hist.loadDaySummaries("u6");
  const sb = summ.find((x) => x.day === dayBeforeKey);
  assert("前天摘要 signedIn=1", sb && sb.signedIn === 1, "got " + JSON.stringify(sb));

  console.log("T7 同到期日碰撞(2026-08-13 小陈实测):历史包与今日签到包同日期不同时刻 → 仍识别今日签到");
  // 历史/促销包:到期日 2026-09-13 08:48:05(早发);今日签到包:到期日 2026-09-13 09:00:50(同日新发)
  const oldPromo = { packageName: "promo", status: 0, capacityRemain: 100, capacityUsed: 0, capacitySize: 100, cycleEndTime: "2026-09-13 08:48:05" };
  const newSignIn = { packageName: "promo", status: 0, capacityRemain: 100, capacityUsed: 0, capacitySize: 100, cycleEndTime: "2026-09-13 09:00:50" };
  assert("碰撞下识别今日签到 = true", derive.detectSignIn([oldPromo], [newSignIn], "2026-08-13") === true, "got " + derive.detectSignIn([oldPromo], [newSignIn], "2026-08-13"));
  assert("完全相同包(非今日新增) = false", derive.detectSignIn([newSignIn], [newSignIn], "2026-08-13") === false, "got " + derive.detectSignIn([newSignIn], [newSignIn], "2026-08-13"));
} catch (e) {
  console.log("  FAIL 测试执行异常: " + e.message);
  failed++;
}

console.log(`\n========== signin-detect: ${passed} 通过 / ${failed} 失败 ==========`);
process.exit(failed ? 1 : 0);
