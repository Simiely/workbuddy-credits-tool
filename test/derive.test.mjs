// test/derive.test.mjs - 派生纯函数口径回归（P0 第一批，零依赖，node:test）
//
// 锁定本周反复漂移的两类口径：
//   consumeByUsed  - 消耗（签到重置 / 新旧格式交界的基准跳变 / baseUsed 计入）
//   todayAddedFrom - 今日到账（按软件源签到常量 100/150，未签到为 0）
// 顺带覆盖 deriveGiftExpiry 的空/非法包过滤（不依赖真实数据）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { consumeByUsed, todayAddedFrom, deriveGiftExpiry } from "../src/compute/derive.js";
import { SIGNIN_CREDIT } from "../src/config.js";

test("consumeByUsed: 空/无/单点 → 0", () => {
  assert.equal(consumeByUsed(), 0);
  assert.equal(consumeByUsed([]), 0);
  assert.equal(consumeByUsed([{ giftUsed: 50, baseUsed: 0, unified: true }]), 0);
});

test("consumeByUsed: 单调 giftUsed 正增量累加", () => {
  const arr = [
    { unified: true, giftUsed: 50, baseUsed: 0 },
    { unified: true, giftUsed: 80, baseUsed: 0 },
    { unified: true, giftUsed: 120, baseUsed: 0 },
  ];
  assert.equal(consumeByUsed(arr), 70);
});

test("consumeByUsed: 签到重置(giftUsed 回退)不计跌破,只计回退后的真实正增量", () => {
  const arr = [
    { unified: false, giftUsed: 94, baseUsed: 0 },
    { unified: false, giftUsed: 0, baseUsed: 0 },   // 签到把已用重置为 0
    { unified: false, giftUsed: 30, baseUsed: 0 },  // 重置后又消耗 30
  ];
  // 94→0 的回落是重置不是消耗;0→30 才是当天真实消耗
  assert.equal(consumeByUsed(arr), 30);
});

test("consumeByUsed: 新旧格式交界基准跳变不误计为消耗", () => {
  const arr = [
    { unified: false, giftUsed: 70, baseUsed: 0 }, // 旧格式末
    { unified: false, giftUsed: 30, baseUsed: 0 }, // 旧格式段内(回落,不计)
    { unified: true, giftUsed: 470, baseUsed: 0 }, // 切新格式,基准跳变 30→470,忽略
    { unified: true, giftUsed: 480, baseUsed: 0 }, // 新格式段内 +10
  ];
  assert.equal(consumeByUsed(arr), 10);
});

test("consumeByUsed: baseUsed 正增量同口径计入", () => {
  const arr = [
    { unified: true, giftUsed: 0, baseUsed: 10 },
    { unified: true, giftUsed: 0, baseUsed: 40 },
  ];
  assert.equal(consumeByUsed(arr), 30);
});

test("consumeByUsed: 浮点四舍五入到 2 位", () => {
  const arr = [
    { unified: true, giftUsed: 0.1, baseUsed: 0 },
    { unified: true, giftUsed: 0.3, baseUsed: 0 },
  ];
  assert.equal(consumeByUsed(arr), 0.2);
});

test("todayAddedFrom: 锁定签到奖励常量(100/150)", () => {
  assert.equal(SIGNIN_CREDIT.workbuddy, 100);
  assert.equal(SIGNIN_CREDIT.traework, 150);
});

test("todayAddedFrom: 已签到按软件源计价", () => {
  assert.equal(todayAddedFrom(true, "workbuddy"), 100);
  assert.equal(todayAddedFrom(true, "traework"), 150);
});

test("todayAddedFrom: 缺省/未知 appKey 按默认(traework)计价", () => {
  assert.equal(todayAddedFrom(true, undefined), 150);
  assert.equal(todayAddedFrom(true, null), 150);
  assert.equal(todayAddedFrom(true, "future-source"), 150);
});

test("todayAddedFrom: 未签到 → 0", () => {
  assert.equal(todayAddedFrom(false, "workbuddy"), 0);
  assert.equal(todayAddedFrom(null, "traework"), 0);
  assert.equal(todayAddedFrom(undefined, "traework"), 0);
});

test("deriveGiftExpiry: 空输入 → 全 0 与空桶", () => {
  const r = deriveGiftExpiry(null);
  assert.equal(r.expiring1d, 0);
  assert.equal(r.expiring2d, 0);
  assert.equal(r.expiring3d, 0);
  assert.equal(r.expiring7d, 0);
  assert.deepEqual(r.giftBuckets, []);
  assert.equal(r.expiryTier.tier, Infinity);
});

test("deriveGiftExpiry: 非法包(未激活/无到期)不过期不计入", () => {
  const r = deriveGiftExpiry([
    { status: 1, cycleEndTime: "2026-10-01 00:00:00", capacityRemain: 200 }, // 已失效
    { status: 0, capacityRemain: 150 }, // 无到期时间
  ]);
  assert.equal(r.expiring1d, 0);
  assert.equal(r.expiring7d, 0);
  assert.deepEqual(r.giftBuckets, []);
});