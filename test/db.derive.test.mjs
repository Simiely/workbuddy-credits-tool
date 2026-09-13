// test/db.derive.test.mjs - 全链路回归（真实 SQLite，但隔离到临时目录，不碰线上 credits.db）
//
// 关键点：在【动态 import】模块图之前把 TRAE_TOOLS_DIR 指向临时目录——
// config.js(=TOOLS_DIR 唯一来源)在首次 import 时才求值，因此本测试进程独立落库、零泄漏。
// 断言 deriveAccount 的今日口径 + gcDaySummaries 的固化窗口(只固化 T-2 起、保留昨天/今天)。
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { before, test } from "node:test";
import assert from "node:assert/strict";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "trae-test-"));
process.env.TRAE_TOOLS_DIR = tmp;

const { deriveAccount, todayAddedFrom } = await import("../src/compute/derive.js");
const { gcDaySummaries } = await import("../src/compute/gc.js");
const { historyFor, loadDaySummaries } = await import("../src/compute/history.js");
const { getDb } = await import("../src/store/db.js");
const { cnDay0, startOfToday, dayKeyOf } = await import("../src/time.js");

const UIN = "test-uin-1";
const DAY_MS = 86400000;

// 直接按显式 ts 写入单行 reading（appendSnapshot 是"整批共享快照时间 + 分钟去重"的采集语义，
// 不适合构造历史时间戳；此处绕过它以精确布点 T-2/昨天/今天）。
function seed(tsMs, giftUsed, signedIn = 0) {
  getDb()
    .prepare(
      "INSERT INTO readings (uin,ts,baseRemain,baseUsed,giftRemain,giftUsed,raw) VALUES (?,?,?,?,?,?,?)"
    )
    .run(
      UIN,
      new Date(tsMs).toISOString(),
      null,
      0,
      1000,
      giftUsed,
      JSON.stringify({ giftRemain: 1000, giftUsed, baseRemain: null, baseUsed: 0, giftPackages: [], signedIn })
    );
}

before(() => {
  // cnDay0 返回 Date；Date+数字会字符串拼接，须 .getTime() 取毫秒，否则"今日"偏移塌缩到 t0
  const today0ms = cnDay0(Date.now()).getTime();
  seed(today0ms + 6 * 3600e3, 1000, 1);               // 今天,已签到
  seed(today0ms + 7 * 3600e3, 1050, 1);               // 今天,已签到
  seed(today0ms - DAY_MS + 6 * 3600e3, 900);          // 昨天(保留窗口内,不固化)
  seed(today0ms - 2 * DAY_MS + 12 * 3600e3, 30);      // T-2 (待固化)
  seed(today0ms - 2 * DAY_MS + 13 * 3600e3, 60);      // T-2 (待固化)
});

test("deriveAccount: 今日消耗/到账/累计,基于独立库", () => {
  const d = deriveAccount(UIN, { name: "t", appKey: "workbuddy" });
  assert.equal(d.todayUsed, 50);       // 1000→1050
  assert.equal(d.signedInToday, true); // 今日快照含 signedIn=1
  assert.equal(d.todayAdded, 100);     // workbuddy 签到奖励
  assert.equal(d.used, 1050);          // 最新总已用
  assert.equal(d.consumed, 1050);
  // 今日到账与日期无关,仅依赖是否签到
  assert.equal(todayAddedFrom(true, "workbuddy"), 100);
});

test("deriveAccount: 未签到 → 今日到账 0", () => {
  const UIN2 = "test-uin-nosign";
  const today0ms = cnDay0(Date.now());
  const db = getDb();
  db.prepare(
    "INSERT INTO readings (uin,ts,baseRemain,baseUsed,giftRemain,giftUsed,raw) VALUES (?,?,?,?,?,?,?)"
  ).run(UIN2, new Date(today0ms + 6 * 3600e3).toISOString(), null, 0, 1000, 1000,
    JSON.stringify({ giftRemain: 1000, giftUsed: 1000, baseRemain: null, baseUsed: 0, giftPackages: [], signedIn: 0 }));
  const d = deriveAccount(UIN2, { name: "t2", appKey: "traework" });
  assert.equal(d.signedInToday, false);
  assert.equal(d.todayAdded, 0);
});

test("gcDaySummaries: 只固化 T-2 及更早,保留昨天/今天;旧明细删除、摘要有值", () => {
  const beforeAll = historyFor(UIN).length; // 5 条:今天2+昨天1+T-2 2
  assert.equal(beforeAll, 5);

  const { fixed } = gcDaySummaries();
  assert.equal(fixed, 1); // 仅 T-2 一天可固化

  // T-2 摘要已落,且 used=30(T-2 两快照 30→60)
  const days = loadDaySummaries(UIN);
  const t2 = days.find((s) => dayKeyOf(new Date(cnDay0(Date.now()) - 2 * DAY_MS + 12 * 3600e3).toISOString()) === s.day);
  assert.ok(t2, "T-2 摘要应存在");
  assert.equal(t2.used, 30);

  // T-2 明细已删,昨天/今天保留
  const after = historyFor(UIN);
  assert.equal(after.length, 3);
  const todayKey = dayKeyOf(startOfToday().toISOString());
  assert.ok(after.some((r) => dayKeyOf(r.ts) === todayKey), "今天明细保留");
});