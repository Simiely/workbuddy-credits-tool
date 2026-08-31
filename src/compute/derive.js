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
//   3. 不碰 IO，IO 仍在 history.js / db.js（唯一例外：packagesFor 缺包时回退读 last-data 缓存）。
//      历史固化(gcDaySummaries) v1.4.58 已拆到 gc.js，本文件不再写库。
//   4. 时区口径（+8）v1.4.58 收敛到 src/time.js，此处只 import 不重复实现。
import { historyFor, loadLastData, loadDaySummaries } from "./history.js";
import { cnWall, cnDay0, dayKeyOf, startOfToday } from "../time.js";

const pad = (n) => String(n).padStart(2, "0");

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

// 消耗口径 v2（v1.4.43 起,今日/单日消耗的最终口径,供 todayUsed/dailyUsed/固化共用）：
// 包级净增量 —— 统计「末快照 active(status=0) 或 用光失效(status≠0 且 remain=0)」的包的 used 增量
//（首快照**全部包**(不过滤 status)为基线,首快照没有则从 0 起;负数截 0;末快照无包数据降级 consumeByPos）。
// 为什么:
//   ①增量口径(consumeByPos)在官方「包失效日」会把今日已用算得比累计还大
//     (2026-08-06 实测:张妈妈今日已用 342、累计净值仅 38——消耗集中在当天失效的包上)。
//   ②基线必须含首快照全部包(含 status≠0):小陈(330100595762)首快照所有包 status=3、
//     末快照恢复 status=0,若基线也过滤 status,这些包会被当成"今天新增"→ 今日已用虚高 1789(实测)。
// v1.4.63 修复(2026-08-15):末快照统计对象从「仅 active」放宽为「active ∪ 用光失效」——
//   包被用光(used=size, remain=0)后 status 0→3,旧口径整包丢弃其当日消耗,导致历史日/固化
//   严重低估、且与当天(残差口径)跨天跳变(实测:张妈妈 8/14 真实消耗 611,旧口径只算 37)。
//   仍排除「到期回收(status≠0 且 remain>0)」的包:剩余被官方收走不是用户消耗,计入会复现
//   v1.4.43 的 342 虚高(8/6 张妈妈)。用光失效包的 remain 必为 0,可精确区分两种"失效"。
export function consumeByPack(arr) {
  if (!arr || !arr.length) return 0;
  const packsOf = (r) => {
    if (Array.isArray(r.giftPackages)) return r.giftPackages;
    try { return JSON.parse(r.raw || "{}").giftPackages || []; } catch { return []; }
  };
  const first = packsOf(arr[0]) || []; // 基线:首快照全部包(不过滤 status,防状态波动导致"伪新增"虚高)
  const last = (packsOf(arr[arr.length - 1]) || []).filter((p) => {
    const st = p.status ?? 0;
    if (st === 0) return true; // active 包:正常统计
    return (p.capacityRemain ?? -1) === 0; // 用光失效(remain=0):真实消耗,计入;到期回收(remain>0):不计
  });
  if (!first.length || !last.length) return consumeByPos(arr); // 首/末任一无包数据(采集异常/旧快照)降级为增量口径
  const key = (p) => (p.cycleEndTime || "") + "|" + (p.packageName || "") + "|" + (p.capacitySize || 0);
  const fMap = new Map();
  for (const p of first) fMap.set(key(p), (fMap.get(key(p)) || 0) + (p.capacityUsed || 0));
  let v = 0;
  const seen = new Set();
  for (const p of last) {
    const k = key(p);
    if (seen.has(k)) continue; // 同键多包(同日同容量)只算一次,避免重复
    seen.add(k);
    const d = (p.capacityUsed || 0) - (fMap.get(k) || 0);
    if (d > 0) v += d;
  }
  // v1.4.70:基础包(体验版)消耗也要计入 —— baseUsed 正增量累加(回退=周期重置,同步基线)。
  // 赠送包走包级首末差、基础包走增量,两者不相交不重复;与 consumeByPos 的 base 口径一致。
  let basePrev = null;
  for (const s of arr) {
    const b = s.baseUsed ?? 0;
    if (basePrev !== null && b > basePrev) v += b - basePrev;
    basePrev = b; // 回退(周期重置)时同步到回退点,后续增量从新基线计
  }
  return Math.round(v * 100) / 100;
}

// 今日签到检测（v1.4.33，碰撞修复 2026-08-13）：
// 原理（数据实证）：WorkBuddy 每日签到 = 新增一个「到期日 = 领取日 + 1 自然月（对日）」的赠送包
// （如 8/5 签到 → 新增 9/5 到期的包；8/4 签到 → 9/4 到期的包，逐日唯一）。
// 检测：最新快照中存在「今日基线快照没有 + cycleEndTime 对日 = 今天+1月」的包。
// - 对日匹配 → 昨天的签到包（昨天+1月）不会误判成今天
// - 不要求满额 → 签到后已消耗（剩余 < 容量）仍能识别
// - 唯一键修复：用「完整 cycleEndTime（到秒）」而非仅日期做已存在判定。
//   否则历史/促销包若与今日签到包巧合同一到期日（如都 2026-09-13，但时刻不同 08:48:05 vs 09:00:50），
//   日期键会碰撞，把今日真实新增的签到包误判为「已存在」→ 漏报今日签到（2026-08-13 小陈实测）。
export function detectSignIn(firstPacks, lastPacks, todayKey) {
  const last = Array.isArray(lastPacks) ? lastPacks : [];
  if (!last.length) return false;
  // 目标到期日 = 今天 + 1 自然月（对日；目标月天数不足则钳到月末，如 8/31 → 9/30）。
  // 不能直接 new Date(y, m, d)：m 为 1 索引而 Date 月份是 0 索引，月末会溢出（8/31 → 10/1）漏判。
  const [y, m, d] = todayKey.split("-").map(Number);
  const nextM = m + 1 > 12 ? 1 : m + 1;
  const nextY = m + 1 > 12 ? y + 1 : y;
  const dim = new Date(Date.UTC(nextY, nextM, 0)).getUTCDate(); // 目标月天数（Date.UTC month 为 0 索引，nextM 传 1 索引值恰好取目标月）
  const target = `${nextY}-${pad(nextM)}-${pad(Math.min(d, dim))}`;
  // 完整 cycleEndTime 作为每个赠送包的唯一键（到秒，区分同日不同时刻的包）；trim 兼容空格/ISO 两种写法
  const firstKeys = new Set(
    (Array.isArray(firstPacks) ? firstPacks : []).map((p) => String(p.cycleEndTime || "").trim())
  );
  return last.some((p) => {
    const end = String(p.cycleEndTime || "").trim();
    const endDay = end.slice(0, 10);
    return endDay === target && !firstKeys.has(end);
  });
}

/**
 * 赠送包 + 基础包到期派生（纯函数，单派生源）。
 * 从快照持久化的子账号列表派生「到期口径」，前端不再从实时 r.data.Accounts 现算。
 * v1.4.72:基础包(体验版)也纳入到期统计 —— deriveAccount 会把最新快照的 baseCycleEnd/baseRemain
 * 合成一条"体验版基础包"传入(仅当剩余>0);giftPacks 本身已过滤体验版,故此处不再排除,不会重复。
 * @param {Array} packs 赠送包列表 + 可选合成基础包 [{packageName,status,capacityRemain,capacityUsed,capacitySize,cycleEndTime}]
 * @returns {{expiring1d:number, expiring3d:number, giftBuckets:Array, expiryTier:{tier:number,amount:number}}}
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
      giftPackages: r.giftPackages, // 包级消耗口径 consumeByPack 需要(status/cycleEndTime/used)
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
    const v = consumeByPack(arr);
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

  // 今日快照序列（todayUsed 改用残差守恒口径，在 yesterdayRemain / todayAdded 算好后再计算，见下方）
  const today0 = startOfToday();
  const todayReadings = series.filter((s) => new Date(s.ts) >= today0);

  // 累计已用 = 历史每日消耗之和(Σ dailyUsed.used,含固化摘要日)，在「今日已用残差」回填 dailyUsed 后再汇总（见下方）。
  // 语义修正(v1.4.43):旧值取最新快照 used 净值,在包失效日会远小于真实历史消耗;现改为「历史累计消耗」。
  let consumed = 0; // 占位,真正汇总在今日已用残差回填 dailyUsed 之后

  // 今日签到检测（v1.4.33，基线修正 2026-08-06）：
  // 基线 = 昨天最后一条快照,目标 = 最新快照,「新增 + 到期日对日=今天+1月」= 已签到。
  // 原基线"今日首条"在用户清晨/凌晨签到早于今日首个快照时失效(首条已含签到包→误判未签到);
  // 签到包只在签到当天新增,昨日最后一条为更稳基线(取不到时退化为今日首条)。
  const todayKey = dayKeyOf(startOfToday().toISOString());
  const todayFull = full.filter((r) => new Date(r.ts) >= today0);
  const beforeToday = full.filter((r) => new Date(r.ts) < today0);
  const baseFull = beforeToday.length
    ? beforeToday[beforeToday.length - 1]
    : todayFull.length
      ? todayFull[0]
      : lastFull;
  const signedInToday = detectSignIn(
    (baseFull && baseFull.giftPackages) || [],
    (lastFull && lastFull.giftPackages) || [],
    todayKey
  );

  // 今日到账 = 今天相对昨日末「新出现的赠送包」容量之和（不管今日消耗/到期移除,恒为非负）。
  // 新包判定用 cycleEndTime 完整串(到秒)做键(与 detectSignIn 修复一致),避免同日期包碰撞。
  // 无昨日基线(今天为首发日)则 null(前端显示 —)。
  let todayAdded = null;
  if (beforeToday.length) {
    const prevPacks = (beforeToday[beforeToday.length - 1].giftPackages) || [];
    const lastPacks = (lastFull && lastFull.giftPackages) || [];
    const prevKeys = new Set(prevPacks.map((p) => String(p.cycleEndTime || "").trim()));
    todayAdded = 0;
    for (const p of lastPacks) {
      const k = String(p.cycleEndTime || "").trim();
      if (!prevKeys.has(k)) {
        todayAdded += p.capacitySize != null ? p.capacitySize : p.capacityRemain != null ? p.capacityRemain : 0;
      }
    }
  }
  // 昨日结余 = 昨天最后一条快照的 totalRemain(beforeToday 末条);无昨日基线(今天首发日)则 null。
  const yesterdayRemain = beforeToday.length ? (beforeToday[beforeToday.length - 1].totalRemain ?? null) : null;

  // —— 今日已用（包级口径，v1.4.63 与历史日/固化统一）——
  // v1.4.62 曾用残差守恒口径（今日已用 = 昨日末剩余 + 今日到账 - 今日末剩余），虽守恒，但
  // ① 把「到期回收的剩余」并入消耗（语义上非用户使用）；② 与历史日/固化用的 consumeByPack
  // 口径不一致 → 同一日期在跨天后从「残差」回落到「包级」数值跳变（8/14 实测 611→37）。
  // v1.4.63 修好 consumeByPack（计入用光失效包，排除到期回收）后，今日/历史日/固化全走
  // consumeByPack，任意跨天不再跳变。yesterdayRemain / todayAdded 仍保留供前端展示。
  const todayUsed = todayReadings.length ? consumeByPack(todayReadings) : 0;

  // 日消耗序列 / 趋势图「今日」那条与今日已用保持一致（避免累计已用漏掉失效包真实消耗）
  for (const d of dailyUsed) { if (d.day === todayKey) d.used = todayUsed; }
  for (const s of seriesOut) { if (dayKeyOf(s.t) === todayKey) s.v = todayUsed; }
  // 累计已用随之重算（含今日真实消耗，口径与今日已用一致）
  consumed = Math.round(dailyUsed.reduce((s, x) => s + (x.used || 0), 0) * 100) / 100;

  // 赠送包到期派生（单派生源）：近1/3天过期积分、周桶、排序紧迫度
  const giftPacks = packagesFor(uin, lastFull);
  // v1.4.72:基础包(体验版)纳入到期统计 —— 从最新快照取 baseCycleEnd/baseRemain 合成一条
  // "体验版基础包"参与派生(仅当剩余>0;用光后剩余0无到期压力,不参与)。giftPacks 已过滤体验版,不会重复。
  const basePacks =
    lastFull && lastFull.baseCycleEnd && (lastFull.baseRemain ?? 0) > 0
      ? [{
          packageName: "体验版基础包",
          status: 0,
          capacityRemain: lastFull.baseRemain,
          capacityUsed: lastFull.baseUsed ?? 0,
          capacitySize: lastFull.baseSize ?? 0,
          cycleEndTime: lastFull.baseCycleEnd,
        }]
      : [];
  const gift = deriveGiftExpiry([...giftPacks, ...basePacks]);
  const expCount = giftPacks.filter((p) => p.status !== 0).length;

  const derived = {
    uin,
    name: acct.name || uin,
    displayName: acct.displayName || acct.name || uin,
    currentRemain,
    used,
    consumed, // 累计已用(历史每日消耗之和,前端"累计已用"展示位统一读它,v1.4.43)
    todayUsed,
    signedInToday,
    todayAdded, // 今日到账(新包容量之和,恒非负;null=无昨日基线,前端显示 —)
    yesterdayRemain, // 昨日末剩余(null=无昨日基线,卡片副信息)
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
