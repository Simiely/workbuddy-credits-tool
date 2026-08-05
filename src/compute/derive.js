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
import {
  historyFor,
  loadLastData,
  loadDaySummaries,
  saveDaySummary,
  readingsForDay,
  oldDayKeys,
  deleteReadingsBefore,
  allSnapshotUins,
} from "./history.js";

const pad = (n) => String(n).padStart(2, "0");

// 中国时区(UTC+8)固定口径:容器(node:alpine 默认 UTC)与桌面(Windows GMT+8)进程时区不同,
// 若按"进程本地时区"算自然日,容器会把 8/3 数据算成 8/2(错位一天,趋势缺日期、今日已用异常)。
// 统一按 +8 计算,与部署环境无关。
const TZ_MS = 8 * 3600 * 1000;
const cnWall = (utcMs) => new Date(utcMs + TZ_MS); // 真实 UTC 时刻 → 中国墙上时间(UTC 视图)
const cnDay0 = (utcMs) => {
  const w = cnWall(utcMs);
  return new Date(Date.UTC(w.getUTCFullYear(), w.getUTCMonth(), w.getUTCDate()) - TZ_MS); // 中国当天 00:00 的真实 UTC 时刻
};

/** 自然日键 YYYY-MM-DD（统一按中国时区 +8） */
export function dayKeyOf(ts) {
  const w = cnWall(new Date(ts).getTime());
  return `${w.getUTCFullYear()}-${pad(w.getUTCMonth() + 1)}-${pad(w.getUTCDate())}`;
}

// 消耗口径（v1.4.31 起，模块级供 deriveAccount 与 gcDaySummaries 共用）：
// 对已按时间排序的快照序列，累计「已用」的正增量。
// 旧口径「首剩余 - 末剩余」在官方赠送包数据调整日会失真：包消失/新增导致剩余漂移
// （甚至增加），把今日消耗算成 0 或负值；改用已用字段后，包重置时已用回退会被跳过
// （prev 同步到回退点），重置后重新从低值累加，能反映真实消耗。
export function consumeByPos(arr) {
  let v = 0, prev = null;
  for (const s of arr) {
    const u = (s.baseUsed || 0) + (s.giftUsed || 0);
    if (prev !== null && u > prev) v += u - prev;
    prev = u; // 回退时同步到回退点,后续增量从新基线计
  }
  return Math.round(v * 100) / 100;
}

// 今日签到检测（v1.4.33）：
// 原理（数据实证）：WorkBuddy 每日签到 = 新增一个「到期日 = 领取日 + 1 自然月（对日）」的赠送包
// （如 8/5 签到 → 新增 9/5 到期的包；8/4 签到 → 9/4 到期的包，逐日唯一）。
// 检测：最新快照中存在「今日首条快照没有 + cycleEndTime 对日 = 今天+1月」的包。
// - 对日匹配 → 昨天的签到包（昨天+1月）不会误判成今天
// - 不要求满额 → 签到后已消耗（剩余 < 容量）仍能识别
// - 对比首条 → 排除早已存在的同到期日包
export function detectSignIn(firstPacks, lastPacks, todayKey) {
  const last = Array.isArray(lastPacks) ? lastPacks : [];
  if (!last.length) return false;
  const [y, m, d] = todayKey.split("-").map(Number);
  const t = new Date(y, m, d); // JS Date 自动进位（月末罕见边界按 JS 行为）
  const target = `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}`;
  const firstKeys = new Set(
    (Array.isArray(firstPacks) ? firstPacks : []).map((p) => String(p.cycleEndTime || "").slice(0, 10))
  );
  return last.some((p) => {
    const end = String(p.cycleEndTime || "").slice(0, 10);
    return end === target && !firstKeys.has(end);
  });
}

/** 中国时区今天 00:00（真实 UTC 时刻） */
export function startOfToday() {
  return cnDay0(Date.now());
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
  const fmtD = (d) => { const w = cnWall(d.getTime()); return `${pad(w.getUTCMonth() + 1)}-${pad(w.getUTCDate())}`; };
  const dayKey = (d) => cnDay0(d.getTime());

  // 近 n 天（含今天，按天比对）到期有效赠送包的剩余积分合计
  const expiringSum = (maxDays) => {
    const limit = new Date(cnDay0(t0.getTime() + maxDays * 86400000).getTime() + 86399999); // 中国 (今天+maxDays) 23:59:59.999
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

  // 按自然日聚合：每天按时间排序，日消耗 = 当天「已用」正增量累加
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
    const v = consumeByPos(arr);
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

  // 历史固化后的旧日(早于保留窗口,原始快照已清)从 day_summary 摘要补齐：
  // 快照能算出的日期优先(更新更准),摘要只补缺失日期。
  const snapDays = new Set(dailyUsed.map((x) => x.day));
  for (const s of loadDaySummaries(uin)) {
    if (snapDays.has(s.day)) continue;
    dailyUsed.push({
      day: s.day,
      used: s.used ?? 0,
      startRemain: s.startRemain ?? null,
      endRemain: s.endRemain ?? null,
    });
    seriesOut.push({ t: s.day + "T00:00:00.000Z", v: s.used ?? 0 }); // 摘要日无真实时刻,取该日 00:00 近似(前端会归一化到本地当天)
  }
  dailyUsed.sort((a, b) => (a.day < b.day ? -1 : 1));
  seriesOut.sort((a, b) => (a.t < b.t ? -1 : 1));

  // 今日已用 = 今日快照序列的「已用」正增量累加（旧口径"首条剩余-当前剩余"在官方包增减时失真）
  const today0 = startOfToday();
  const todayReadings = series.filter((s) => new Date(s.ts) >= today0);
  const todayUsed = todayReadings.length ? consumeByPos(todayReadings) : 0;

  // 今日签到检测（v1.4.33）：今日首条 vs 最新快照的赠送包,「新增 + 到期日对日=今天+1月」= 已签到
  const todayKey = dayKeyOf(startOfToday().toISOString());
  const todayFull = full.filter((r) => new Date(r.ts) >= today0);
  const signedInToday = detectSignIn(
    todayFull.length ? todayFull[0].giftPackages : [],
    (lastFull && lastFull.giftPackages) || [],
    todayKey
  );

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
    todayUsed,
    signedInToday,
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

// ---------- 历史固化（v1.4.31 规划落地） ----------
// 把「T-2 及更早」的每日原始快照压缩为 day_summary 摘要，然后删除原始明细，
// 防止历史无限增长（原 wb-history.json 3.8MB 上传慢的根因）。
// 幂等：某日摘要已存在则跳过；保留窗口 = 昨天(T-1)与今天（todayUsed/dailyUsed 现算需要）。
export function gcDaySummaries() {
  const nowMs = Date.now();
  const todayKey = new Date(nowMs + TZ_MS).toISOString().slice(0, 10);
  const today0Utc = new Date(todayKey + "T00:00:00Z").getTime() - TZ_MS; // 中国今天 00:00 的 UTC 时刻
  const cutMs = today0Utc - 1 * 86400000; // 保留窗口起点 = 昨天 00:00；<cut 的旧日全部固化后删除
  const accts = allSnapshotUins(); // 只处理有快照的账号（字符串数组，不依赖账号池）
  let fixed = 0;
  for (const uin of accts) {
    const existing = new Set(loadDaySummaries(uin).map((s) => s.day)); // 幂等键
    for (const day of oldDayKeys(uin, cutMs)) {
      if (existing.has(day)) continue; // 已固化，跳过
      const rows = readingsForDay(uin, day);
      if (!rows.length) continue;
      const v = consumeByPos(rows);
      const first = rows[0];
      const last = rows[rows.length - 1];
      // 当天签到状态：该日首条 vs 末条快照的赠送包,「新增 + 到期日对日=当日+1月」= 当天已签到
      const packsOf = (r) => {
        try { return (JSON.parse(r.raw || "{}").giftPackages) || []; } catch { return []; }
      };
      const signedIn = detectSignIn(packsOf(first), packsOf(last), day) ? 1 : 0;
      saveDaySummary(
        uin,
        day,
        v,
        first ? (first.baseRemain || 0) + (first.giftRemain || 0) : null,
        last ? (last.baseRemain || 0) + (last.giftRemain || 0) : null,
        signedIn
      );
      fixed++;
    }
  }
  if (fixed > 0) deleteReadingsBefore(new Date(cutMs).toISOString()); // 有固化才清理（保留 T-1 与今天）
  return { fixed };
}
