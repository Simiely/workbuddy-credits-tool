// test/derive-consume.test.mjs — 消耗口径回归（v1.4.31）
// 场景:官方赠送包数据调整日(包消失/新增 → 已用回退、剩余漂移),「首剩余-末剩余」口径失真,
//       新口径「已用正增量累加」应正确反映真实消耗。
// 运行: node test/derive-consume.test.mjs    （run-all.mjs 自动纳入）
// 隔离方式: 复制 src/ 到系统临时目录(TOOLS_DIR 指向临时目录,绝不触碰真实 credits.db)。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wb-derive-test-"));
fs.cpSync(path.join(ROOT, "src"), path.join(tmp, "src"), { recursive: true });

let passed = 0, failed = 0;
const assert = (n, c, x = "") => { if (c) { passed++; console.log("  PASS " + n); } else { failed++; console.log("  FAIL " + n + (x ? "  << " + x : "")); } };

// 中国时区日期工具(与 derive 的 +8 口径一致)
const TZ_MS = 8 * 3600 * 1000;
const cnDateOf = (utcMs) => new Date(utcMs + TZ_MS).toISOString().slice(0, 10); // 真实UTC时刻 → 中国日期
const todayKey = cnDateOf(Date.now());
const dayStartUtc = (key) => new Date(key + "T00:00:00Z").getTime() - TZ_MS; // 中国某天00:00的真实UTC时刻
const yesterdayKey = cnDateOf(dayStartUtc(todayKey) - 86400000);
const at = (key, hour) => new Date(dayStartUtc(key) + hour * 3600 * 1000).toISOString();

const mk = (uin, ts, bR, bU, gR, gU, packs = []) => ({
  uin, ts,
  baseRemain: bR, baseUsed: bU, giftRemain: gR, giftUsed: gU,
  summary: { baseRemain: bR, baseUsed: bU, giftRemain: gR, giftUsed: gU },
  giftPackages: packs, // 包级消耗口径(consumeByPack)读它;不带则降级为增量口径
});

try {
  const { getDb } = await import("file:///" + tmp.replace(/\\/g, "/") + "/src/store/db.js");
  const hist = await import("file:///" + tmp.replace(/\\/g, "/") + "/src/compute/history.js");
  const derive = await import("file:///" + tmp.replace(/\\/g, "/") + "/src/compute/derive.js");

  // 注意:appendSnapshot 同分钟去重是全局的(不分账号),各场景快照必须用互不相同的分钟
  console.log("T1 正常消耗(used 单调增) → 今日已用 = 已用增量 = 60");
  hist.appendSnapshot([mk("u1", at(todayKey, 1.1), 500, 100, 3000, 0)], { ts: at(todayKey, 1.1) });
  hist.appendSnapshot([mk("u1", at(todayKey, 3.2), 500, 130, 3000, 0)], { ts: at(todayKey, 3.2) });
  hist.appendSnapshot([mk("u1", at(todayKey, 6.3), 500, 160, 3000, 0)], { ts: at(todayKey, 6.3) });
  let d = derive.deriveAccount("u1");
  assert("今日已用 = 60", d.todayUsed === 60, "got " + d.todayUsed);
  assert("dailyUsed 今日 = 60", (d.dailyUsed.find((x) => x.day === todayKey) || {}).used === 60);
  assert("累计已用 consumed = 60(历史每日消耗之和)", d.consumed === 60, "got " + d.consumed);

  console.log("T2 官方包重置(used 回退后再涨) → 重置前 26 + 重置后 40 = 66");
  hist.appendSnapshot([mk("u2", at(todayKey, 2.1), 500, 0, 3250, 270)], { ts: at(todayKey, 2.1) });
  hist.appendSnapshot([mk("u2", at(todayKey, 2.4), 500, 0, 3224, 296)], { ts: at(todayKey, 2.4) });
  hist.appendSnapshot([mk("u2", at(todayKey, 2.7), 500, 0, 3220, 0)], { ts: at(todayKey, 2.7) });
  hist.appendSnapshot([mk("u2", at(todayKey, 8.9), 500, 0, 3280, 40)], { ts: at(todayKey, 8.9) });
  d = derive.deriveAccount("u2");
  assert("今日已用 = 66(旧口径会是 0)", d.todayUsed === 66, "got " + d.todayUsed);
  assert("剩余差确实失真(3250-3280<0)", (3250 - d.currentRemain) < 0);

  console.log("T3 持平无新增消耗 → 今日已用不变");
  hist.appendSnapshot([mk("u2", at(todayKey, 12.1), 500, 0, 3280, 40)], { ts: at(todayKey, 12.1) });
  d = derive.deriveAccount("u2");
  assert("今日已用仍 = 66", d.todayUsed === 66, "got " + d.todayUsed);

  console.log("T4 昨日正常 + 今日重置 → dailyUsed/seriesOut 序列正确");
  hist.appendSnapshot([mk("u3", at(yesterdayKey, 1.1), 500, 0, 3600, 100)], { ts: at(yesterdayKey, 1.1) });
  hist.appendSnapshot([mk("u3", at(yesterdayKey, 8.2), 500, 0, 3570, 130)], { ts: at(yesterdayKey, 8.2) });
  hist.appendSnapshot([mk("u3", at(todayKey, 10.2), 500, 0, 3500, 130)], { ts: at(todayKey, 10.2) });
  hist.appendSnapshot([mk("u3", at(todayKey, 10.6), 500, 0, 3470, 0)], { ts: at(todayKey, 10.6) });
  hist.appendSnapshot([mk("u3", at(todayKey, 11.1), 500, 0, 3430, 40)], { ts: at(todayKey, 11.1) });
  d = derive.deriveAccount("u3");
  const y = d.dailyUsed.find((x) => x.day === yesterdayKey);
  const t = d.dailyUsed.find((x) => x.day === todayKey);
  assert("昨日消耗 = 30", y && y.used === 30, "got " + (y && y.used));
  assert("今日消耗 = 40(包级口径降级 consumeByPos:giftUsed 130→0→40 正增量累加;重置回退不产生负消耗)", t && t.used === 40, "got " + (t && t.used));
  const sOut = d.series.find((x) => x.t.startsWith(todayKey));
  assert("series 今日 v = 40", sOut && sOut.v === 40, "got " + (sOut && sOut.v));

  console.log("T5 已用回退后不产生负消耗(回退+持平)");
  hist.appendSnapshot([mk("u4", at(todayKey, 13.1), 500, 0, 2000, 100)], { ts: at(todayKey, 13.1) });
  hist.appendSnapshot([mk("u4", at(todayKey, 13.5), 500, 0, 1900, 60)], { ts: at(todayKey, 13.5) });
  hist.appendSnapshot([mk("u4", at(todayKey, 14.1), 500, 0, 1900, 60)], { ts: at(todayKey, 14.1) });
  d = derive.deriveAccount("u4");
  assert("今日已用 = 0", d.todayUsed === 0, "got " + d.todayUsed);

  console.log("T6 包失效日(用户实况:今日消耗集中在失效包) → 包级口径 今日 <= 累计");
  const pk = (end, st, used) => ({ packageName: "P", status: st, capacityUsed: used, capacityRemain: 100 - used, capacitySize: 100, cycleEndTime: end });
  // u5:今天 包A(9/1到期)用 5→8;包B(今天到期)用 3 后转 status=3(失效)
  hist.appendSnapshot([mk("u5", at(todayKey, 4.1), 500, 0, 8, 8, [pk("2026-09-01", 0, 5), pk("2026-08-06", 0, 3)])], { ts: at(todayKey, 4.1) });
  hist.appendSnapshot([mk("u5", at(todayKey, 5.1), 500, 0, 8, 8, [pk("2026-09-01", 0, 8), pk("2026-08-06", 3, 3)])], { ts: at(todayKey, 5.1) });
  d = derive.deriveAccount("u5");
  assert("今日已用 = 3(只算存活包A增量,失效包B不计)", d.todayUsed === 3, "got " + d.todayUsed);
  assert("今日(3) <= 累计(8)", d.todayUsed <= d.used, `got today=${d.todayUsed} used=${d.used}`);

  console.log("T7 包失效日的消耗归属(8/5 场景) → 包级口径:到期回收(status=3 且 remain>0)不计入消耗");
  // u6:昨天 包C(8/6到期)用 5→10 + 包D 用 0→2;今天 包C 失效(剩余90被回收),包D 用 2→5
  hist.appendSnapshot([mk("u6", at(yesterdayKey, 1.3), 500, 0, 12, 5, [pk("2026-08-06", 0, 5), pk("2026-09-01", 0, 0)])], { ts: at(yesterdayKey, 1.3) });
  hist.appendSnapshot([mk("u6", at(yesterdayKey, 8.3), 500, 0, 12, 12, [pk("2026-08-06", 0, 10), pk("2026-09-01", 0, 2)])], { ts: at(yesterdayKey, 8.3) });
  hist.appendSnapshot([mk("u6", at(todayKey, 2.2), 500, 0, 2, 2, [pk("2026-08-06", 3, 10), pk("2026-09-01", 0, 2)])], { ts: at(todayKey, 2.2) });
  hist.appendSnapshot([mk("u6", at(todayKey, 3.3), 500, 0, 5, 5, [pk("2026-08-06", 3, 10), pk("2026-09-01", 0, 5)])], { ts: at(todayKey, 3.3) });
  d = derive.deriveAccount("u6");
  const yD = d.dailyUsed.find((x) => x.day === yesterdayKey);
  const tD = d.dailyUsed.find((x) => x.day === todayKey);
  assert("昨日消耗 = 7(失效包C 昨日消耗计入昨日,不抹 0)", yD && yD.used === 7, "got " + (yD && yD.used));
  assert("今日消耗 = 3(包C 到期回收 remain=90>0 不计入,只算包D 2→5 增量;v1.4.63 口径)", tD && tD.used === 3, "got " + (tD && tD.used));
  // 注:v1.4.63 起今日/历史日/固化统一包级口径;「到期回收」的剩余不是用户消耗,不计入(与 v1.4.62 残差口径不同:残差会把回收的 90 也算成今日消耗 → 7)
  assert("今日已用 = 3(包级口径,到期回收不计)", d.todayUsed === 3, "got " + d.todayUsed);
  assert("累计已用 consumed = 10(昨日7+今日3)", d.consumed === 10, "got " + d.consumed);

  console.log("T8 用光失效(status=3 且 remain=0)当日消耗必须计入(v1.4.63 核心修复)");
  // u7:今天 包E 用 0→100 后用光(remain=0,status 0→3);包F 无变化 → 今日消耗 = 100(旧口径整包丢弃只得 0)
  hist.appendSnapshot([mk("u7", at(todayKey, 5.0), 500, 0, 200, 0, [pk("2026-09-20", 0, 0), pk("2026-09-21", 0, 0)])], { ts: at(todayKey, 5.0) });
  hist.appendSnapshot([mk("u7", at(todayKey, 6.0), 500, 0, 100, 100, [pk("2026-09-20", 3, 100), pk("2026-09-21", 0, 0)])], { ts: at(todayKey, 6.0) });
  d = derive.deriveAccount("u7");
  assert("今日已用 = 100(用光失效包E 的当日消耗计入,旧口径只数 active 包会算成 0)", d.todayUsed === 100, "got " + d.todayUsed);
  assert("累计已用 consumed = 100", d.consumed === 100, "got " + d.consumed);

  console.log("T9 基础包(体验版)消耗计入(v1.4.70 修复) → baseUsed 0→50 计入今日消耗");
  // u8:带 giftPackages(走包级主路径),baseUsed 0→50 → 今日消耗 = 基础包 50 + 赠送包 0 = 50
  hist.appendSnapshot([mk("u8", at(todayKey, 7.1), 500, 0, 100, 0, [pk("2026-09-10", 0, 0)])], { ts: at(todayKey, 7.1) });
  hist.appendSnapshot([mk("u8", at(todayKey, 7.6), 450, 50, 100, 0, [pk("2026-09-10", 0, 0)])], { ts: at(todayKey, 7.6) });
  d = derive.deriveAccount("u8");
  assert("今日已用 = 50(基础包 0→50 计入,旧口径只数赠送包会算成 0)", d.todayUsed === 50, "got " + d.todayUsed);
  assert("累计已用 consumed = 50", d.consumed === 50, "got " + d.consumed);

  console.log("T10 基础包周期重置(0→30→0→20) → 重置前 30 + 重置后 20 = 50");
  hist.appendSnapshot([mk("u9", at(todayKey, 8.2), 500, 0, 100, 0, [pk("2026-09-10", 0, 0)])], { ts: at(todayKey, 8.2) });
  hist.appendSnapshot([mk("u9", at(todayKey, 8.4), 470, 30, 100, 0, [pk("2026-09-10", 0, 0)])], { ts: at(todayKey, 8.4) });
  hist.appendSnapshot([mk("u9", at(todayKey, 8.6), 500, 0, 100, 0, [pk("2026-09-10", 0, 0)])], { ts: at(todayKey, 8.6) });
  hist.appendSnapshot([mk("u9", at(todayKey, 8.8), 480, 20, 100, 0, [pk("2026-09-10", 0, 0)])], { ts: at(todayKey, 8.8) });
  d = derive.deriveAccount("u9");
  assert("今日已用 = 50(重置前 30 + 重置后 20,回退同步基线不产生负消耗)", d.todayUsed === 50, "got " + d.todayUsed);
  assert("累计已用 consumed = 50", d.consumed === 50, "got " + d.consumed);

  console.log("T11 基础包 + 赠送包同时消耗 → 两者相加");
  // u10:基础包 0→20 + 赠送包 0→10(包级) → 今日消耗 = 30
  hist.appendSnapshot([mk("u10", at(todayKey, 9.1), 500, 0, 100, 0, [pk("2026-09-10", 0, 0)])], { ts: at(todayKey, 9.1) });
  hist.appendSnapshot([mk("u10", at(todayKey, 9.5), 480, 20, 90, 10, [pk("2026-09-10", 0, 10)])], { ts: at(todayKey, 9.5) });
  d = derive.deriveAccount("u10");
  assert("今日已用 = 30(基础包 20 + 赠送包 10)", d.todayUsed === 30, "got " + d.todayUsed);
  assert("累计已用 consumed = 30", d.consumed === 30, "got " + d.consumed);
} catch (e) {
  console.log("  FAIL 测试执行异常: " + e.message);
  failed++;
}

console.log(`\n========== derive-consume: ${passed} 通过 / ${failed} 失败 ==========`);
process.exit(failed ? 1 : 0);
