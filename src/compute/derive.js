// src/compute/derive.js - 派生引擎（纯函数，唯一派生口径，TRAE Work 版）
//
// 消费 Readings 时序（historyFor），产出 Derived 视图：currentRemain / todayUsed /
// 日消耗序列 / 趋势 / 过期。每日消耗 = 相邻自然日末快照 giftUsed 之差（服务器总量，非 WB 式逐包推算）。
// ⚠️ usage_summary.consumed_amount **不是**历史累计（2026-09-22 实测推翻旧注释）：
//    它 ==「当前仍存在的积分包的已用之和」，服务端回收过期包时会整体回落（实测每次 -100）。
//    故"累计消耗"由 base + 每日正增量还原，见下方 consumed 处的说明。
// 过期统计：读最新快照 giftPackages（字段已对齐 WB），按 cycleEndTime 算近1/2/3/7天到期。
import { historyFor, loadDaySummaries, loadBaseline } from "./history.js";
import { loadLedger, ledgerFromSnapshots } from "./ledger.js";
import { cnWall, cnDay0, dayKeyOf, startOfToday } from "../time.js";
import { SIGNIN_CREDIT, DEFAULT_SIGNIN_CREDIT } from "../config.js";

const pad = (n) => String(n).padStart(2, "0");

// 余量判定阈值：余量按两位小数记账，< 本值视为「已耗尽、无可作废的分」。
// 与 ledger.js 的 EPS 同口径（同一批两位小数数据，别处也用它判"事件是否成立"）。
const EPS_REMAIN = 0.005;

/**
 * TRAE 消耗口径：对已排序快照序列，取首末 giftUsed 之差的正值。
 * ⚠️ usage_summary.consumed_amount **不是**单调累计（旧注释写反，2026-09-22 实测纠正）：
 *    它等于当前存在包的已用之和，包被回收时会回落，所以跨日消耗必须按「正增量」扫描，
 *    遇下降视为基线重置（不把落差算成负消耗）。首条缺失(无基线)则从 0 起。
 * @param {Array} arr 已按时间排序的快照（含 giftUsed）
 */
/**
 * used 读数三态格式（与 ledger.js fmtOf 同口径的**单一来源**）：
 *   legacy=统一模型前（used 随签到重置）、unified=v1 口径、unified-v2=v2 口径
 *   （WB 2026-09-30 换读数字段，按类型声明 + Precise）。
 * v1.9.2 从 consumeByUsed 内联抽出共用：差分引擎与「口径切换日」标记必须同一判定，
 * 否则会出现"标了切换日却没断账"（或反之）的口径漂移。
 */
export function usedFmtOf(s) {
  return !s.unified ? "legacy" : (s.usedScheme === 2 ? "unified-v2" : "unified");
}

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
    // 三态格式见 usedFmtOf()：v1/unified 与 v2(unified-v2) 的 used 基准
    // 整体不同（WB 2026-09-30 换读数字段），交界同样刷新基准、不累计。
    const fmt = usedFmtOf(s);
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
 * 今日到账（证据优先，纯函数）：快照里「今天发的签到包」的实发容量就是权威值。
 *
 * 为什么不能只靠常量：TRAE 的签到奖励官方已三次下调（200 → 150 → 100，2026-09-30 起 100，
 * 官方社区 09-30 公告确认）。常量永远追不上官方改口径 —— 而快照里就有真值可读：
 * TRAE 签到包的 entitlement_id 形如 `checkin_20261027_<uin>`，日期段即发放日（北京时区），
 * capacitySize 即当日实发。读它，官方以后改成 50/200 都自动跟随，不用再改代码。
 *
 * 判据（两个条件都必需）：
 *   ① rid 以 `checkin_<YYYYMMDD>` 开头 —— 签到包专属前缀（monthly_bonus_/free_ 等不匹配）；
 *   ② 日期段 == 今天（北京时区，todayKey 由 dayKeyOf 产出，"YYYY-MM-DD"）——
 *     只认「今天发的」，历史签到包（31 天窗口内都在）不能算进今天。
 * 同 rid 去重后求和（正常一天一个包；上游若拆包发放也能对账）。
 *
 * 兜底链：有当日包证据 → 实发值（此时**不看** signedInToday —— 包存在本身就是签到铁证，
 * 免得 checkin 接口瞬时失败把已到账写成 0，与 signedInToday 的"任一快照为真"同哲学）；
 * 无证据（旧快照缺 rid / 当日包未生成）→ 退回 todayAddedFrom（已签按常量、未签为 0）。
 *
 * @param {object} opts
 * @param {boolean|null} opts.signedInToday 今日是否已签到（兜底用）
 * @param {string|null} [opts.appKey] 软件源（兜底计价用）
 * @param {Array} [opts.packages] 最新快照的 giftPackages（需含 rid/capacitySize）
 * @param {string} [opts.todayKey] 今日自然日键 "YYYY-MM-DD"（dayKeyOf 口径）
 * @returns {number}
 */
export function todayAddedOf({ signedInToday, appKey, packages = [], todayKey = "" } = {}) {
  const today = String(todayKey || "").replace(/-/g, "");
  if (today) {
    let sum = 0;
    const seen = new Set();
    for (const p of packages || []) {
      const m = p && String(p.rid || "").match(/^checkin_(\d{8})_/);
      if (!m || m[1] !== today || seen.has(p.rid)) continue;
      seen.add(p.rid);
      sum += Number(p.capacitySize) || 0;
    }
    if (sum > 0) return Math.round(sum * 100) / 100;
  }
  return todayAddedFrom(signedInToday, appKey);
}

/**
 * 赠送包到期派生（复用 WB 口径，纯函数）。
 * 从快照持久化的包列表派生「近1/2/3/7天过期」「周桶」「排序紧迫度」。
 * giftPackages 字段：packageName/status/capacityRemain/capacityUsed/capacitySize/cycleEndTime(本地串)。
 */
/**
 * 包的到期时刻（Date）——**权威优先用服务端秒时间戳**（TRAE 有 endTimeS），只在缺失时
 * 回退解析 cycleEndTime 字符串（WB 只有字符串）。字符串**无时区标记**，解析结果取决于运行
 * 环境 TZ（容器设 Asia/Shanghai 才对得上）；用秒时间戳可彻底摆脱这个隐含依赖。
 * 解析失败返回 null。过期统计与"含过期 N"共用本函数，保证口径唯一。
 */
export function packEndOf(p) {
  if (p && p.endTimeS) return new Date(Number(p.endTimeS) * 1000);
  const s = p && p.cycleEndTime;
  if (!s) return null;
  const dt = new Date(String(s).replace(" ", "T"));
  return isNaN(dt.getTime()) ? null : dt;
}

/**
 * 单个包的展示状态 —— 前端明细的「状态」列直接读它，**不在 UI 层重算**。
 * 判据只看**余量与到期时刻**：落库时 `status` 已被归一化为 0（见 model.js），它不携带
 * "是否有效"的信息，前端原先按 `p.status === 0 ? "有效" : "失效"` 判断 → 恒显示"有效"，
 * 已用尽/已作废的包也标成有效（2026-09-28 一并修）。
 *   'used'  已用尽（余量 0）—— 不会再作废任何分
 *   'stale' 已过期但仍有余额 —— 这部分分**已经作废**
 *   'ok'    仍在有效期内且有余量
 */
export function packStateOf(p, now = Date.now()) {
  const rem = (p && p.capacityRemain) || 0;
  if (rem <= EPS_REMAIN) return "used";
  const e = packEndOf(p);
  if (e && e.getTime() < now) return "stale";
  return "ok";
}

export function deriveGiftExpiry(packs) {
  // 到期时刻解析：统一走模块级 packEndOf（权威秒时间戳优先，回退字符串；口径唯一）
  const parse = packEndOf;
  // 「会作废的包」= 有到期时间 **且仍有余量**。两个条件都是必需的：
  //  ① 刻意不看 p.status：TRAE 的 status 与 WB 的 Status 不是同一套枚举（实测两值都有余额、
  //     Σ包余量 == 服务端 giftRemain 零残差），拿它当有效性判据会让 TRAE 的签到包整批被排除
  //     —— 那是"过期积分算不准"的根因（2026-09-28）。
  //  ② 必须余量 > 0：已耗尽的包（剩 0）**没有任何分会作废**，对"过期压力"的贡献恒为 0。
  //     把它算进来会让紧迫度层被无意义地拉早 —— 实测小黄trae 今天有个「签到奖励 1 剩 0.00」
  //     到期 → tier=0/amount=0，于是它被排到"明天有 744 分要作废"的账号**前面**。
  //     这是"过期排序不对"的根因（2026-09-28）：排序键被一堆空包污染了。
  const clean = (packs || []).filter(
    (p) => !!parse(p) && (p.capacityRemain || 0) > EPS_REMAIN
  );
  const t0 = startOfToday();
  const fmtD = (d) => { const w = cnWall(d.getTime()); return `${pad(w.getUTCMonth() + 1)}-${pad(w.getUTCDate())}`; };
  const dayKey = (d) => cnDay0(d.getTime());

  const expiringSum = (maxDays) => {
    const limit = new Date(cnDay0(t0.getTime() + maxDays * 86400000).getTime() + 86399999);
    let s = 0;
    for (const p of clean) {
      const dt = parse(p);
      if (dt && dt >= t0 && dt <= limit) s += p.capacityRemain || 0;
    }
    return Math.round(s * 100) / 100;
  };
  const expiring1d = expiringSum(1);
  const expiring2d = expiringSum(2);
  const expiring3d = expiringSum(3);
  const expiring7d = expiringSum(7);
  // 30 天窗口：TRAE 的签到包有效期就是 30 天，而**先到期的先被消耗** → 1~7 天内的包通常
  // 早已用尽（余量 0、不进统计）。于是到期压力天然全落在 8~30 天这一段，只给 1/2/3/7 天
  // 四个窗口时，一个"30 天内 2987 分要作废"的账号会显示成 0/0/0/0 —— 用户据此报
  // 「明明有很多分要过期，为什么没有计算」（2026-09-28）。本档与 expiryTier 的 SCAN_MAX 同界。
  const expiring30d = expiringSum(30);

  // 周桶
  const sorted = [...clean].sort((a, b) => (a.cycleEndTime < b.cycleEndTime ? -1 : 1));
  const buckets = [];
  let cur = null;
  for (const p of sorted) {
    const dt = parse(p);
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
    const dt = parse(p);
    if (!dt) continue;
    const diff = Math.floor((dayKey(dt) - t0) / 86400000);
    // diff >= 0：今天到期(diff=0)也算最紧迫层；此前 diff>=1 会把"今天到期"漏进无压力组
    if (diff >= 0 && diff <= SCAN_MAX) {
      dayAmounts.set(diff, Math.round(((dayAmounts.get(diff) || 0) + (p.capacityRemain || 0)) * 100) / 100);
      if (diff < tier) tier = diff;
    }
  }
  const expiryTier =
    tier === Infinity
      ? { tier: Infinity, amount: 0 }
      : { tier, amount: dayAmounts.get(tier) || 0 };

  return { expiring1d, expiring2d, expiring3d, expiring7d, expiring30d, giftBuckets: buckets, expiryTier };
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
      usedScheme: r.usedScheme ?? 1,
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
    // 口径切换日（v1.9.2）：该日读数跨越 used 语义版本（如 2026-09-30 的 v1↔v2 交界），
    // 交界差分被断账守卫丢弃 → 当日消耗**必然不完整**。打标记给 GUI 画角标，
    // 避免日后翻历史时把缺口误读成"那天没用"。判定与 consumeByUsed 同源（usedFmtOf）。
    const so = { t: d1.ts, v };
    const du = { day: k, used: v, startRemain: d0.totalRemain, endRemain: d1.totalRemain };
    if (new Set(arr.map(usedFmtOf)).size > 1) { so.b = 1; du.schemeBoundary = 1; }
    seriesOut.push(so);
    dailyUsed.push(du);
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
    // ⚠️ 跨 used 语义版本（v1↔v2）时禁用本兜底：昨日末与今日首条的 used 基准整体不同
    // （WB 2026-09-30 换读数字段），差分是**基准差不是消耗** —— 与 consumeByUsed 的
    // 格式交界规则同一条纪律，宁可显示 0（下个采样周期凑满两条 v2 后自动走正常路径）。
    if ((lastY.usedScheme ?? 1) === (todayReadings[0].usedScheme ?? 1)) {
      const diff = (todayReadings[0].giftUsed ?? 0) - (lastY.giftUsed ?? 0);
      todayUsed = Math.round(Math.max(0, diff) * 100) / 100;
    }
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

  // 今日到账 = 账号今日签到奖励 —— **证据优先**（v1.9.5）：
  //   快照里今天发的签到包（rid=checkin_<日期>_<uin>）的实发容量是权威值，官方调额度
  //   （TRAE 200→150→100，2026-09-30 起 100）自动跟随；读不到才退回 SIGNIN_CREDIT 常量。
  //   见 todayAddedOf 顶部说明。
  // 注:更早的「今日新出现包容量和」把同上账号的整批新包(体验版500/多个裂变包等)都计入,
  //    导致 WorkBuddy 单日到账虚高到 600/4244、hero 合计 6000+ —— 所以证据只认
  //    checkin_ 专属前缀，不做"所有新包求和"那种宽口径。
  const rawPacks = lastFull && Array.isArray(lastFull.giftPackages) ? lastFull.giftPackages : [];
  const todayAdded = todayAddedOf({ signedInToday, appKey: acct.appKey, packages: rawPacks, todayKey });

  // 回填今日消耗到日序列
  for (const d of dailyUsed) if (d.day === todayKey) d.used = todayUsed;
  for (const s of seriesOut) if (dayKeyOf(s.t) === todayKey) s.v = todayUsed;

  // 累计消耗（截至今日之前）—— v1.8.0 账本口径，见 ledger.js 顶部「为什么整体重写」
  //
  // 删掉的三样东西与理由：
  //   1) consumed_baseline 的"每日并入正增量"——账本自己就会逐日累加，base 退化为**只写一次的
  //      历史起点**（迁移前已固化到 2026-09-26，含被回收包的历史消耗，符合用户口径"用掉就算"）；
  //   2) epoch 世代隔离——它把"服务端回收积分包"误判成"账号重建"，抛弃锚点与全部日用量，
  //      正是累计跳水的原因（09-24 小陈trae 8247.4→3852.56、09-27 小黄trae 6306.78→2106.78）；
  //   3) 水位线托底（max 当前 cum）—— 它会在包回收后把累计往回拽，且与账本口径重复。
  //
  // 现行口径：累计 = 起点 base + Σ 账本(day < 今天).used。账本只用「剩余」逐对差分记账，
  // 服务端回收只进 added/recycled，**不可能**再抹掉已发生的消耗 ⇒ 数字只增不减。
  // 起点 base：优先锚点（迁移前的历史累计，只写一次，见 ledger.js）。锚点缺失时
  // （新账号首见 / 老库尚未 gc 初始化）退回「首条快照的已用」——保守下界，gc 初始化后自动转正。
  const baseRow = loadBaseline(uin);
  const base = baseRow == null ? Number((first && first.giftUsed) || 0) : Number(baseRow) || 0;
  const lrows = loadLedger(uin, todayKey);
  const sumOf = (k) => Math.round(lrows.reduce((x, r) => x + (Number(r[k]) || 0), 0) * 100) / 100;
  const ledgerUsed = sumOf("used");
  // 兜底：账本缺行、但明细还在的旧日（典型：NAS 刚重启、gc 还没跑到）现算补上，
  // 否则那一天的消耗要等下次 gc 才计入（表现为"数字比实际小一截"）。只补不算，不落库。
  const ledgerDays = new Set(lrows.map((r) => r.day));
  let pendingUsed = 0;
  for (const [k, arr] of byDay) {
    if (k >= todayKey || ledgerDays.has(k)) continue;
    pendingUsed = Math.round((pendingUsed + ledgerFromSnapshots(arr).used) * 100) / 100;
  }
  // 观测下界：今日之前快照里出现过的最大已用。缺锚点、或账本滞后时兜底。
  // 与锚点口径**取大**是安全的：两者都只增（账本只累加正增量、观测下界本身就是单调包络），
  // 而且这正是旧模型"水位线托底"想做的事 —— 区别是它不再需要靠猜"账号有没有被重建"。
  const observedMax = series
    .filter((s) => dayKeyOf(s.ts) !== todayKey)
    .reduce((m, s) => Math.max(m, s.totalUsed ?? 0, s.giftUsed ?? 0), 0);
  const consumed = Math.round(Math.max(base + ledgerUsed + pendingUsed, observedMax) * 100) / 100;
  const consumedTotal = Math.round((consumed + todayUsed) * 100) / 100;

  // 过期派生（读最新快照 giftPackages；rawPacks 已在上方取出，同一份不重读）
  // 每个包带出展示状态 state（packStateOf）—— 明细弹窗的「状态」列直读它，UI 层不再自己判。
  const giftPacks = rawPacks.map((p) => ({ ...p, state: packStateOf(p) }));
  const gift = deriveGiftExpiry(giftPacks);
  // 已失效的包**个数**（≠ 会作废的**分**）。前端原先把这个数当"近30天过期"显示，单位错位 →
  // 用户看到「近30天过期 8」而实际有 2987 分要作废，据此报"没计算/算漏了"（2026-09-28）。
  // 现在它是「已失效 N 个」的包计数，金额一律走 expiring* 系列。
  // 也**不再用 status 判**：旧式 `p.status !== 0 || ...` 会把 TRAE 全部签到包算成"过期"
  // （实测 29 个包里 27 个），前端"含过期 N"因此长期虚高。
  const expCount = giftPacks.filter((p) => {
    const rem = p.capacityRemain ?? 0;
    if (rem <= 0 && (p.capacitySize ?? 0) > 0) return true;   // 已耗尽
    const e = packEndOf(p);
    return !!e && e.getTime() < Date.now() && rem > 0;        // 已过期但有余量（作废）
  }).length;

  return {
    uin,
    name: acct.name || uin,
    displayName: acct.displayName || acct.name || uin,
    currentRemain,
    used,
    consumed,
    consumedTotal,   // consumed(截至昨日) + 今日消耗 = 含今日的全量累计
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
    expiring30d: gift.expiring30d,   // TRAE 签到包有效期 30 天 → 到期压力主要落在这一档
    giftBuckets: gift.giftBuckets,
    expiryTier: gift.expiryTier,
    // v1.8.0 账本口径（取代 epoch 世代）：起点 base + 账本累计。
    // added/recycled 是给用户解释"积分为什么变多/变少"的——回收从此是**可见的账目**，
    // 而不是像旧模型那样被当成"账号重建"去重置累计。
    ledger: {
      base,
      used: Math.round((ledgerUsed + pendingUsed) * 100) / 100,
      added: sumOf("added"),
      recycled: sumOf("recycled"),
      days: lrows.length,
    },
  };
}

/** 批量派生（账号池顺序，保持展示稳定） */
export function deriveAll(accounts) {
  return accounts.map((a) => deriveAccount(a.uin, a));
}
