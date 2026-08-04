// src/compute/derive.js - 派生引擎（纯函数，唯一派生口径）
//
// 这是「额度遥测管线」的派生层（P2）。它消费 Readings 时序（来自 historyFor），
// 产出 Derived 视图：currentRemain / todayUsed / 日消耗序列 dailyUsed / 趋势 series / 赠送包到期。
//
// 设计要点：
//   1. 纯函数、无副作用、单数据源（readings 表）。之前散落在 buildDashboard / render / 前端
//      loadHist 三处的「日消耗 = 当日首快照剩余 - 末快照剩余」逻辑，现在收口到这一处。
//   2. todayUsed 由「今日首个快照剩余 - 当前剩余」得到（相邻 Reading 之差），
//      根治旧版「今日已用恒为0」（旧版每天只有一次快照导致首末相等→0；P1 采样器已让每天多条）。
//   3. 不碰 IO，IO 仍在 history.js / db.js —— 本文件可独立单测。
import { historyFor, loadLastData } from "./history.js";

const pad = (n) => String(n).padStart(2, "0");

/** 自然日键 YYYY-MM-DD（按本地时区） */
export function dayKeyOf(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 本地时区今天 00:00 */
export function startOfToday() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

/**
 * 赠送包到期派生（纯函数，单派生源）。
 * 从快照持久化的子账号列表派生「到期口径」，前端不再从实时 r.data.Accounts 现算。
 * @param {Array} packs 非体验版赠送包列表 [{packageName,status,capacityRemain,capacityUsed,capacitySize,cycleEndTime}]
 * @returns {{expiring1d:number, expiring3d:number, giftBuckets:Array, expiryTier:{tier:number,amount:number}}}
 */
export function deriveGiftExpiry(packs) {
  const clean = (packs || []).filter(
    (p) => !(p.packageName || "").includes("体验版") && p.status === 0 && !!p.cycleEndTime
  );
  const parse = (s) => {
    const dt = new Date(String(s).replace(" ", "T"));
    return isNaN(dt.getTime()) ? null : dt;
  };
  const t0 = startOfToday();
  const fmtD = (d) => `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const dayKey = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());

  // 近 n 天（含今天，按天比对）到期有效赠送包的剩余积分合计
  const expiringSum = (maxDays) => {
    const limit = new Date(t0.getTime() + maxDays * 86400000);
    limit.setHours(23, 59, 59, 999);
    let s = 0;
    for (const p of clean) {
      const dt = parse(p.cycleEndTime);
      if (dt && dt >= t0 && dt <= limit) s += p.capacityRemain || 0;
    }
    return s;
  };
  const expiring1d = expiringSum(1);
  const expiring2d = expiringSum(2);
  const expiring3d = expiringSum(3);
  const expiring7d = expiringSum(7);

  // 周桶（从今天起每 7 天一桶，按 CycleEndTime 归入）
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
    cur.total += p.capacityRemain || 0;
    cur.count++;
  }

  // 排序紧迫度：最早出现过期量的天(1..30)与该天过期量
  const SCAN_MAX = 30;
  let tier = Infinity;
  const dayAmounts = new Map();
  for (const p of clean) {
    const dt = parse(p.cycleEndTime);
    if (!dt) continue;
    const diff = Math.floor((dayKey(dt) - t0) / 86400000);
    if (diff >= 1 && diff <= SCAN_MAX) {
      dayAmounts.set(diff, (dayAmounts.get(diff) || 0) + (p.capacityRemain || 0));
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
 * 取某账号的赠送包列表：优先用最新快照的 giftPackages（已持久化），
 * 缺字段时回退到本地缓存 last-data（避免老快照未落包列表时到期口径为空）。
 */
function packagesFor(uin, last) {
  if (last && Array.isArray(last.giftPackages) && last.giftPackages.length)
    return last.giftPackages;
  try {
    const ld = loadLastData();
    const rr = (ld && ld.results || []).find(
      (x) => x.account && x.account.uin === uin
    );
    if (rr && rr.data && Array.isArray(rr.data.Accounts)) {
      return rr.data.Accounts.filter(
        (a) => !(a.PackageName || "").includes("体验版")
      ).map((a) => ({
        packageName: a.PackageName || "",
        status: a.Status ?? 0,
        capacityRemain: a.CapacityRemain ?? 0,
        capacityUsed: a.CapacityUsed ?? 0,
        capacitySize: a.CapacitySize ?? 0,
        cycleEndTime: a.CycleEndTime || "",
      }));
    }
  } catch {}
  return [];
}

/**
 * 由时序数据为单账号派生全部指标。
 * @param {string} uin
 * @param {object} [acct] 账号对象（含 name/displayName）
 * @returns {object} Derived
 */
export function deriveAccount(uin, acct = {}) {
  const full = historyFor(uin); // 完整末条含 giftPackages/giftSize/baseCycleEnd 等快照字段
  const series = full
    .map((r) => ({
      ts: r.ts,
      baseRemain: r.baseRemain ?? 0,
      baseUsed: r.baseUsed ?? 0,
      giftRemain: r.giftRemain ?? 0,
      giftUsed: r.giftUsed ?? 0,
      totalRemain: r.totalRemain ?? 0,
      totalUsed: r.totalUsed ?? 0,
    }))
    .sort((a, b) => (a.ts < b.ts ? -1 : 1));

  const n = series.length;
  const first = n ? series[0] : null;
  const last = n ? series[n - 1] : null; // 仅用于趋势/剩余计算
  const lastFull = full.length ? full[full.length - 1] : null; // 完整字段(含赠送包/汇总口径)
  const currentRemain = last ? last.totalRemain : 0;
  const used = last ? last.totalUsed : 0;

  // 按自然日聚合：每天取最早/最晚快照，日消耗 = 首剩余 - 末剩余
  const byDay = new Map();
  for (const s of series) {
    const k = dayKeyOf(s.ts);
    if (!byDay.has(k)) byDay.set(k, []);
    byDay.get(k).push(s);
  }

  const seriesOut = []; // 趋势图用：每日 {t, v}（v=当日消耗）
  const dailyUsed = []; // 日消耗序列（含日期）
  for (const [k, arr] of byDay) {
    arr.sort((a, b) => (a.ts < b.ts ? -1 : 1));
    const d0 = arr[0];
    const d1 = arr[arr.length - 1];
    const v = Math.max(0, Math.round((d0.totalRemain - d1.totalRemain) * 100) / 100);
    seriesOut.push({ t: d1.ts, v });
    // 明细表直接消费：起(首快照剩余)/终(末快照剩余)/日消耗,前端不再按日聚合重算
    dailyUsed.push({
      day: k,
      used: v,
      startRemain: d0.totalRemain,
      endRemain: d1.totalRemain,
    });
  }
  seriesOut.sort((a, b) => (a.t < b.t ? -1 : 1));
  dailyUsed.sort((a, b) => (a.day < b.day ? -1 : 1));

  // 今日已用 = 今日最早快照剩余 - 当前剩余（相邻 Reading 之差）
  const today0 = startOfToday();
  const todayReadings = series.filter((s) => new Date(s.ts) >= today0);
  let todayUsed = 0;
  if (todayReadings.length) {
    const baseline = todayReadings[0].totalRemain;
    todayUsed = Math.max(0, Math.round((baseline - currentRemain) * 100) / 100);
  }

  // 累计消耗（自首次记录以来）
  const consumed =
    n > 1 ? Math.max(0, Math.round((first.totalRemain - last.totalRemain) * 100) / 100) : 0;

  // 赠送包到期派生（单派生源）：近1/3天过期积分、周桶、排序紧迫度
  const giftPacks = packagesFor(uin, lastFull);
  const gift = deriveGiftExpiry(giftPacks);
  const expCount = giftPacks.filter((p) => p.status !== 0).length;

  const derived = {
    uin,
    name: acct.name || uin,
    displayName: acct.displayName || acct.name || uin,
    currentRemain,
    used,
    consumed,
    todayUsed,
    points: n,
    series: seriesOut,
    dailyUsed,
    firstTs: first ? first.ts : null,
    lastTs: last ? last.ts : null,
    // ---- 赠送包到期（单派生源，前端只读派生结果） ----
    baseRemain: lastFull ? lastFull.baseRemain ?? null : null,
    baseUsed: lastFull ? lastFull.baseUsed ?? null : null,
    baseSize: lastFull ? lastFull.baseSize ?? null : null,
    baseCycleEnd: lastFull ? lastFull.baseCycleEnd ?? null : null,
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
  return derived;
}

/** 批量派生（账号池顺序，保持展示稳定） */
export function deriveAll(accounts) {
  return accounts.map((a) => deriveAccount(a.uin, a));
}
