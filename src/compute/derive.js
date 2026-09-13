// src/compute/derive.js - 派生引擎（纯函数，唯一派生口径，TRAE Work 版）
//
// 消费 Readings 时序（historyFor），产出 Derived 视图：currentRemain / todayUsed /
// 日消耗序列 / 趋势 / 过期。TRAE 的消耗权威口径 = usage_summary.consumed_amount(giftUsed 快照)，
// 每日消耗 = 相邻自然日末快照 giftUsed 之差（服务器总量，非 WB 式逐包推算）。
// 过期统计：读最新快照 giftPackages（字段已对齐 WB），按 cycleEndTime 算近1/2/3/7天到期。
import { historyFor, loadDaySummaries } from "./history.js";
import { cnWall, cnDay0, dayKeyOf, startOfToday } from "../time.js";
import { SIGNIN_CREDIT, DEFAULT_SIGNIN_CREDIT } from "../config.js";

const pad = (n) => String(n).padStart(2, "0");

/**
 * TRAE 消耗口径：对已排序快照序列，取首末 giftUsed 之差的正值。
 * TRAE 的 usage_summary.consumed_amount 是服务器权威累计消耗（单调非负增长），
 * 跨自然日的消耗 = 相邻两快照 giftUsed 差值。首条缺失(无基线)则从 0 起。
 * @param {Array} arr 已按时间排序的快照（含 giftUsed）
 */
export function consumeByUsed(arr) {
  if (!arr || !arr.length) return 0;
  // 消耗口径 = 「已用」正增量累加 + 基础包正增量累加。
  // 官方赠送包数据会被「签到重置/包消失/新增」打断：giftUsed 会整体回退(如 94→0 签到入账+100)。
  // 简单「末 - 首」会把当天真实消耗算成 0(末<首被钳 0)，必须按时间扫描累计正增量，
  // 遇下降视为重置基线同步(不把重置落差当消耗)，同时计入基础包 baseUsed 正增量(对齐 WB 口径)。
  // 格式不连续：同一账号合并「旧结构(baseRemain 有值)」与「当前工具新结构(baseRemain=null)」两份
  // 快照时，两套 giftUsed 语义不同(旧随签到重置/新为单调累计)，在交界处基准会整体跳变
  // (如旧末 giftUsed=70 → 新首 giftUsed=470)。若把交界跳变计入会把基准差误当当天消耗(累成 +400)。
  // 故相邻快照格式不一致时刷新基准、不累计，只统计同一格式连续段内的真实正增量。
  let add = 0;
  let pg = null, pb = null, prevFmt = null;
  for (const s of arr) {
    const g = typeof s.giftUsed === "number" ? s.giftUsed : 0;
    const b = typeof s.baseUsed === "number" ? s.baseUsed : 0;
    const fmt = s.unified ? "unified" : "legacy";
    if (pg !== null && fmt === prevFmt) {
      if (g > pg) add += g - pg;
      if (b > pb) add += b - pb;
    }
    pg = g;
    pb = b;
    prevFmt = fmt;
  }
  return Math.round(add * 100) / 100;
}

// 今日签到：TRAE 有专门接口(checkin_credits/status)在采集时取得；此处从 day_summary.signedIn 或快照回放。
// derive 阶段不依赖元数据推断(WB 式 detectSignIn 不适用 TRAE 无"签到包"结构)。

/**
 * 今日到账（纯函数）：仅当账号今日实际签到才计入，数值按软件源签到奖励常量。
 * @param {boolean} signedInToday 今日是否已签到（参考断言，见 deriveAccount）
 * @param {string|null} [appKey] 软件源（workbuddy | traework），未知/缺省按 DEFAULT 计价
 */
export function todayAddedFrom(signedInToday, appKey) {
  if (signedInToday !== true) return 0;
  return SIGNIN_CREDIT[appKey || "traework"] ?? DEFAULT_SIGNIN_CREDIT;
}

/**
 * 赠送包到期派生（复用 WB 口径，纯函数）。
 * 从快照持久化的包列表派生「近1/2/3/7天过期」「周桶」「排序紧迫度」。
 * giftPackages 字段：packageName/status/capacityRemain/capacityUsed/capacitySize/cycleEndTime(本地串)。
 */
export function deriveGiftExpiry(packs) {
  const clean = (packs || []).filter(
    (p) => p.status === 0 && !!p.cycleEndTime
  );
  const parse = (s) => {
    const dt = new Date(String(s).replace(" ", "T"));
    return isNaN(dt.getTime()) ? null : dt;
  };
  const t0 = startOfToday();
  const fmtD = (d) => { const w = cnWall(d.getTime()); return `${pad(w.getUTCMonth() + 1)}-${pad(w.getUTCDate())}`; };
  const dayKey = (d) => cnDay0(d.getTime());

  const expiringSum = (maxDays) => {
    const limit = new Date(cnDay0(t0.getTime() + maxDays * 86400000).getTime() + 86399999);
    let s = 0;
    for (const p of clean) {
      const dt = parse(p.cycleEndTime);
      if (dt && dt >= t0 && dt <= limit) s += p.capacityRemain || 0;
    }
    return Math.round(s * 100) / 100;
  };
  const expiring1d = expiringSum(1);
  const expiring2d = expiringSum(2);
  const expiring3d = expiringSum(3);
  const expiring7d = expiringSum(7);

  // 周桶
  const sorted = [...clean].sort((a, b) => (a.cycleEndTime < b.cycleEndTime ? -1 : 1));
  const buckets = [];
  let cur = null;
  for (const p of sorted) {
    const dt = parse(p.cycleEndTime);
    if (!dt) continue;
    const day = dayKey(dt);
    const diff = Math.max(0, Math.floor((day - t0) / 86400000));
    const bi = Math.floor(diff / 7);
    if (!cur || cur.idx !== bi) {
      cur = {
        idx: bi,
        start: fmtD(new Date(t0.getTime() + bi * 7 * 86400000)),
        end: fmtD(new Date(t0.getTime() + (bi * 7 + 6) * 86400000)),
        total: 0,
        count: 0,
      };
      buckets.push(cur);
    }
    cur.total = Math.round((cur.total + (p.capacityRemain || 0)) * 100) / 100;
    cur.count++;
  }

  // 排序紧迫度
  const SCAN_MAX = 30;
  let tier = Infinity;
  const dayAmounts = new Map();
  for (const p of clean) {
    const dt = parse(p.cycleEndTime);
    if (!dt) continue;
    const diff = Math.floor((dayKey(dt) - t0) / 86400000);
    if (diff >= 1 && diff <= SCAN_MAX) {
      dayAmounts.set(diff, Math.round(((dayAmounts.get(diff) || 0) + (p.capacityRemain || 0)) * 100) / 100);
      if (diff < tier) tier = diff;
    }
  }
  const expiryTier =
    tier === Infinity
      ? { tier: Infinity, amount: 0 }
      : { tier, amount: dayAmounts.get(tier) || 0 };

  return { expiring1d, expiring2d, expiring3d, expiring7d, giftBuckets: buckets, expiryTier };
}

/**
 * 由时序数据为单账号派生全部指标。
 * @param {string} uin
 * @param {object} [acct] 账号对象（含 name/displayName）
 * @returns {object} Derived
 */
export function deriveAccount(uin, acct = {}) {
  const full = historyFor(uin); // 完整末条含 giftPackages/giftSize 等
  const series = full
    .map((r) => ({
      ts: r.ts,
      unified: r.unified ?? false,
      baseRemain: r.baseRemain ?? null,
      giftRemain: r.giftRemain ?? 0,
      giftUsed: r.giftUsed ?? 0,
      totalRemain: r.totalRemain ?? 0,
      totalUsed: r.totalUsed ?? 0,
      giftPackages: r.giftPackages,
    }))
    .sort((a, b) => (a.ts < b.ts ? -1 : 1));

  const n = series.length;
  const first = n ? series[0] : null;
  const last = n ? series[n - 1] : null;
  const lastFull = full.length ? full[full.length - 1] : null;
  const currentRemain = last ? last.totalRemain : 0;
  const used = last ? last.totalUsed : 0; // 累计消耗 = 最新 giftUsed(usage_summary 权威)

  // 按中国自然日聚合
  const byDay = new Map();
  for (const s of series) {
    const k = dayKeyOf(s.ts);
    if (!byDay.has(k)) byDay.set(k, []);
    byDay.get(k).push(s);
  }

  const seriesOut = [];
  const dailyUsed = [];
  for (const [k, arr] of byDay) {
    arr.sort((a, b) => (a.ts < b.ts ? -1 : 1));
    const d0 = arr[0];
    const d1 = arr[arr.length - 1];
    const v = consumeByUsed(arr);
    seriesOut.push({ t: d1.ts, v });
    dailyUsed.push({ day: k, used: v, startRemain: d0.totalRemain, endRemain: d1.totalRemain });
  }
  seriesOut.sort((a, b) => (a.t < b.t ? -1 : 1));
  dailyUsed.sort((a, b) => (a.day < b.day ? -1 : 1));

  // 固化摘要补齐旧日
  const snapDays = new Set(dailyUsed.map((x) => x.day));
  for (const s of loadDaySummaries(uin)) {
    if (snapDays.has(s.day)) continue;
    dailyUsed.push({ day: s.day, used: s.used ?? 0, startRemain: s.startRemain ?? null, endRemain: s.endRemain ?? null });
    seriesOut.push({ t: s.day + "T00:00:00.000Z", v: s.used ?? 0 });
  }
  dailyUsed.sort((a, b) => (a.day < b.day ? -1 : 1));
  seriesOut.sort((a, b) => (a.t < b.t ? -1 : 1));

  const today0 = startOfToday();
  const todayKey = dayKeyOf(startOfToday().toISOString());

  // 今日已用 = 今日快照首末 giftUsed 差；不足两快照则用「今日末 giftUsed - 昨日末 giftUsed」
  const todayReadings = series.filter((s) => new Date(s.ts) >= today0);
  const beforeToday = series.filter((s) => new Date(s.ts) < today0);
  let todayUsed = 0;
  if (todayReadings.length >= 2) {
    todayUsed = consumeByUsed(todayReadings);
  } else if (todayReadings.length === 1 && beforeToday.length) {
    const lastY = beforeToday[beforeToday.length - 1];
    const diff = (todayReadings[0].giftUsed ?? 0) - (lastY.giftUsed ?? 0);
    todayUsed = Math.round(Math.max(0, diff) * 100) / 100;
  }

  // 昨日结余
  const yesterdayRemain = beforeToday.length ? beforeToday[beforeToday.length - 1].totalRemain ?? null : null;

  // 今日签到（TRAE 由实时 checkin 接口固化在快照；签到为每日一次、当天恒定）。
  // 取「今日任一条快照 signedIn=1」即视为已签到 —— 避免某次签到接口瞬时失败/被限流返回
  // checked_in=false 时把末快照写成 0，误把今天已签的标记清掉（2026-09-04 实测末快照 signed 0）。
  const signedInToday = (() => {
    if (!full.length) return null;
    const t0 = startOfToday();
    const todayRows = full.filter((r) => new Date(r.ts) >= t0);
    if (!todayRows.length) return null; // 今日尚无快照
    return todayRows.some((r) => !!r.signedIn);
  })();

  // 今日到账 = 账号今日签到奖励（口径已按各软件源实测快照对齐，见 todayAddedFrom）：
  //   仅当账号今日实际签到(signedInToday)时计入；未签到/今日无快照为 0。
  // 注:旧的「今日新出现包容量和」把同上账号的整批新包(体验版500/多个裂变包等)都计入,
  //    导致 WorkBuddy 单日到账虚高到 600/4244、hero 合计 6000+,故改为按来源的每日签到奖励常量。
  const todayAdded = todayAddedFrom(signedInToday, acct.appKey);

  // 回填今日消耗到日序列
  for (const d of dailyUsed) if (d.day === todayKey) d.used = todayUsed;
  for (const s of seriesOut) if (dayKeyOf(s.t) === todayKey) s.v = todayUsed;

  // 历史累计消耗：优先最新 usage_summary(used)，否则历史日消耗和
  let consumed = used;
  if (!consumed) consumed = Math.round(dailyUsed.reduce((x, s) => x + (s.used || 0), 0) * 100) / 100;

  // 过期派生（读最新快照 giftPackages）
  const giftPacks = (lastFull && Array.isArray(lastFull.giftPackages)) ? lastFull.giftPackages : [];
  const gift = deriveGiftExpiry(giftPacks);
  const expCount = giftPacks.filter((p) => p.status !== 0 || (p.capacityRemain ?? 0) === 0 && p.capacitySize > 0).length;

  return {
    uin,
    name: acct.name || uin,
    displayName: acct.displayName || acct.name || uin,
    currentRemain,
    used,
    consumed,
    todayUsed,
    signedInToday,
    todayAdded,
    yesterdayRemain,
    points: n,
    series: seriesOut,
    dailyUsed,
    firstTs: first ? first.ts : null,
    lastTs: last ? last.ts : null,
    baseRemain: null,
    baseUsed: null,
    baseSize: null,
    baseCycleEnd: null,
    giftRemain: lastFull ? lastFull.giftRemain ?? null : null,
    giftUsed: lastFull ? lastFull.giftUsed ?? null : null,
    giftSize: lastFull ? lastFull.giftSize ?? null : null,
    giftPacks,
    expCount,
    expiring1d: gift.expiring1d,
    expiring2d: gift.expiring2d,
    expiring3d: gift.expiring3d,
    expiring7d: gift.expiring7d,
    giftBuckets: gift.giftBuckets,
    expiryTier: gift.expiryTier,
  };
}

/** 批量派生（账号池顺序，保持展示稳定） */
export function deriveAll(accounts) {
  return accounts.map((a) => deriveAccount(a.uin, a));
}
