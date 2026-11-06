// src/compute/model.js - TRAE Work 数据模型（唯一解析口径）
// 把 api.trae.cn 的 user_current_entitlement_list 原始返回解析为统一模型。
// TRAE 结构：
//   usage_summary: { total_amount, consumed_amount, consumption_ratio }  ← 总池口径（唯一权威总消耗）
//   user_entitlement_pack_list: [ { display_desc, status, entitlement_base_info:{currency, quota.credits_limit, end_time, ent_status,...}, usage:{credits_amount} } ]
//     - currency=1 → 通用/可耗积分包（有 credits_limit）
//     - currency=0 → 免费功能包（无 credits_limit，不计入积分）
// 求和：第二个参数既可以是**字段名**（a[k]），也可以是**取值函数**（k(a)）。
// 历史上两处调用各用一种写法（`sum(credits, "x")` 与 `sum(credits, (p) => ...)`），
// 而定义只支持字段名 → 传函数时 a[k] 恒为 undefined，兜底分支被静默算成 0
// （2026-09-28 核对过期口径时发现）。统一支持两种，调用点不必再迁就。
const sum = (arr, k) =>
  arr.reduce((s, a) => s + ((typeof k === "function" ? k(a) : a[k]) || 0), 0);

const isCreditable = (p) => (p.entitlement_base_info && p.entitlement_base_info.currency) === 1;
const usedOf = (p) => (p.usage && typeof p.usage.credits_amount === "number" ? p.usage.credits_amount : 0);
const nowS = () => Math.floor(Date.now() / 1000);

const _num = (v) => {
  const n = typeof v === "string" ? parseFloat(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : 0;
};

/**
 * 单个 WorkBuddy 积分包的字段选取 —— **声明式**，唯一的取值口径（2026-09-30 换根基）。
 * wb.js 的 parseWbResources 与本文件的 buildWbSnapshotEntry 共用本函数，口径只写这一份
 * （此前两处各写一份"整数优先"的选取且同错 —— 双写正是 2026-09-30 架构审计点名的断裂点）。
 *
 * 【为什么不能再用 `CapacityUsed != null ? CapacityUsed : CapacityUsedPrecise`】
 *   ① 方向反了：整数版是**各自截断**的，三元组对不上账（爸爸体验版整数 500/357/142，
 *      357+142=499≠500；Precise 500/353.47/146.53 严丝合缝）→ 必须永远 Precise 优先。
 *   ② 周期额度包（CapacityType=4）的 Capacity* 是**冻结值**，真实用量只在 CycleCapacity*：
 *      读冻结字段 → 今日消耗恒 0（2026-09-30 用户报障的根因）。
 *      2026-09-30 对 192 个包全量核对：type 1/4 = 186/6，与"普通字段是否冻结"完全对应。
 *   之前试过 max/min 钳位，那是止血；按类型声明取值才是治本 —— 不猜、不钳。
 * @returns {{size:number, used:number, remain:number, kind:"quota"|"grant",
 *            rid:string, cycleId:string, startAt:number|null}}
 */
export function pickWbPackFields(p) {
  const isQuota = _num(p.CapacityType) === 4;
  // 永远 Precise 优先，缺失时才回退整数字段（同族内口径一致）
  const fam = isQuota ? "CycleCapacity" : "Capacity";
  const pick = (base) =>
    p[base + "Precise"] != null ? _num(p[base + "Precise"]) : _num(p[base]);
  return {
    size: pick(fam + "Size"),
    used: pick(fam + "Used"),
    remain: pick(fam + "Remain"),
    kind: isQuota ? "quota" : "grant",
    // 资源身份（上游一直在给，此前落库时被扔掉了 —— 身份模型阶段 0 开始保留）：
    // rid@cycleId 唯一确定一个积分资源；startAt 是"今日到账"的判据（可取代签到常量）。
    rid: p.ResourceId || String(p.AccountId ?? ""),
    cycleId: isQuota ? String(p.CycleStartTime || "") : "",
    startAt: p.CreateTime != null ? _num(p.CreateTime) || null : null, // 毫秒
  };
}

/** TRAE 包的种类：monthly_bonus_ 前缀 = 周期额度包；free_ = 免费功能包；其余 = 一次性发放 */
export function traePackKind(p) {
  const id = ((p.entitlement_base_info || {}).entitlement_id) || "";
  if (id.startsWith("monthly_bonus_")) return "quota";
  if (id.startsWith("free_")) return "free";
  return "grant";
}

/** 给重复描述的包附加编号（老用户福利 → 老用户福利 1 / 老用户福利 2） */
function uniqueLabels(names) {
  const count = {};
  names.forEach((n) => (count[n] = (count[n] || 0) + 1));
  const seen = {};
  return names.map((n) => {
    seen[n] = (seen[n] || 0) + 1;
    return count[n] > 1 ? `${n} ${seen[n]}` : n;
  });
}

/**
 * 把 TRAE 原始返回（data 对象）解析为统一模型。
 * @param {object} D 即 user_current_entitlement_list 返回的 data（含 usage_summary + pack_list）
 */
export function parseEntitlementData(D) {
  const packs = (D && D.user_entitlement_pack_list) || [];
  const us = (D && D.usage_summary) || {};
  const credits = packs.filter(isCreditable);          // 可耗积分包
  const now = nowS();
  // 「有效包」判据 = 周期未结束（**只看 end_time，不看 p.status**）：
  //   TRAE 的 status 与 WorkBuddy 的 Status 不是同一套枚举 —— 实测 status=0 与 status=1
  //   的包都持有余额，且「Σ各包 capacityRemain == 服务端 giftRemain」逐账号零残差
  //   （2026-09-28 实测，小黄trae 的 2993.22 全部来自 status=1 的签到包）。
  //   旧代码用 `p.status === 0` 当有效性判据 → 签到包整批被塞进 expired →
  //   expCount 虚高、activeRemain 偏小、"即将过期"整块统计漏掉大头。
  const endedOf = (p) => (((p.entitlement_base_info || {}).end_time) || 0) <= now;
  const active = credits.filter((p) => !endedOf(p));
  const expired = credits.filter(endedOf);

  // 总口径：优先 usage_summary（官方权威），缺失则累加各包
  const giftSize = us.total_amount ?? sum(credits, (p) => p.entitlement_base_info.quota?.credits_limit ?? 0);
  const giftUsed = us.consumed_amount ?? sum(credits, usedOf);
  const giftRemain = Math.max(0, giftSize - giftUsed);
  const activeSize = sum(active, (p) => p.entitlement_base_info.quota?.credits_limit ?? 0);
  const activeUsed = sum(active, usedOf);

  return {
    raw: packs,
    packs: credits,          // 全部可耗积分包（含过期）
    active,
    expired,
    base: null,              // TRAE 无独立体验版 base 包
    giftSize,
    giftUsed,
    giftRemain,
    activeSize,
    activeUsed,
    activeRemain: Math.max(0, activeSize - activeUsed),
    giftCount: credits.length,
    expCount: expired.length,
    totalRemain: giftRemain,
    totalUsed: giftUsed,
    freePack: packs.find((p) => (p.entitlement_base_info?.currency) === 0) || null,
  };
}

/** 汇总口径（兼容 summarize 字段语义，供 API/前端） */
export function summarize(D) {
  const m = parseEntitlementData(D);
  return {
    giftUsed: m.giftUsed,
    giftSize: m.giftSize,
    giftRemain: m.giftRemain,
    giftCount: m.giftCount,
    expCount: m.expCount,
    // 保留字段名以对齐历史 render/GUI（TRAE 无 base）
    baseUsed: null,
    baseSize: null,
    baseRemain: null,
    baseCycleEnd: null,
  };
}

/**
 * 把秒时间戳转成 "YYYY-MM-DD HH:mm:ss"(北京时间) 字符串，供 derive 的 cycleEndTime 复用。
 */
function bjStr(ts) {
  if (!ts) return "";
  try {
    const d = new Date(ts * 1000);
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  } catch { return String(ts); }
}

/**
 * 构造一条「快照写入条目」：把本次查询的汇总 + 可耗积分包列表一并打包，
 * 供 history.appendSnapshot 落库（readings 表）。
 * 包列表随快照持久化 → 「过期口径/排序/到期明细」在 derive 从单一真相源派生。
 * giftPackages 字段对齐 WB 命名(packageName/status/capacityRemain/capacityUsed/capacitySize/cycleEndTime)，
 * 使 derive.js 的过期/包派生逻辑可直接复用。cycleEndTime 用 "YYYY-MM-DD HH:mm:ss" 本地串。
 * @param {{account, data, summary}} r fetchAllAccounts 的单条结果
 */
export function buildSnapshotEntry(r) {
  // WorkBuddy 来源：data 为 get-user-resource 的 data.Response.Data（Accounts[] 即积分资源包）
  if (r.account && r.account.appKey === "workbuddy") {
    return buildWbSnapshotEntry(r);
  }
  const s = r.summary || null;
  const packs = ((r.data && r.data.user_entitlement_pack_list) || []).filter(isCreditable);
  const rawLabels = packs.map((p) => (p.display_desc || "积分").trim());
  const labels = uniqueLabels(rawLabels);
  const giftPackages = packs.map((p, i) => {
    const inf = p.entitlement_base_info || {};
    const limit = inf.quota?.credits_limit ?? 0;
    const used = usedOf(p);
    const kind = traePackKind(p);
    return {
      packageName: labels[i],           // 展示名(含重复编号)
      desc: rawLabels[i],
      // ⚠️ status 归一化为 WB 语义的 0（=有效），**不能**直接搬服务端的 p.status：
      //    TRAE 的 status 与 WorkBuddy 的 Status 不是同一套枚举 —— 实测两值都有余额、
      //    且「Σ各包 capacityRemain == 服务端 giftRemain」逐账号零残差（2026-09-28），
      //    说明 status=1 的包同样是**账上有效**的剩余（如签到包）。直接搬会发生：
      //    deriveGiftExpiry 的 `status === 0` 过滤把它们整批排除 → 过期统计漏掉大头
      //    （小黄trae 的 2993.22 全是 status=1 → 过期统计恒为 0；坤坤trae 漏 41%）。
      //    原始值另存 statusRaw 供排查。packs 已经过 isCreditable 过滤（只留可耗积分包）。
      status: 0,
      statusRaw: p.status ?? null,
      capacityRemain: Math.max(0, limit - used),
      capacityUsed: used,
      capacitySize: limit,
      cycleEndTime: bjStr(inf.end_time), // "YYYY-MM-DD HH:mm:ss" 本地串(与 WB 对齐)
      endTimeS: inf.end_time || null,    // 原始秒时间戳(备用)
      // 资源身份（阶段 0，纯增量；读数逻辑零改动）：entitlement_id 实测同账号内唯一、
      // 跨抓取稳定（2026-09-30 验证 311/311）。kind=quota 的包 used 随周期滚动。
      rid: inf.entitlement_id || "",
      cycleId: kind === "quota" ? String(inf.start_time ?? "") : "",
      kind,
      startAt: inf.start_time != null ? inf.start_time * 1000 : null, // 毫秒
    };
  });
  return {
    uin: r.account.uin,
    name: r.account.name,
    displayName: r.account.displayName,
    baseRemain: null,
    baseUsed: null,
    baseSize: null,
    baseCycleEnd: null,
    giftRemain: s ? s.giftRemain : null,
    giftUsed: s ? s.giftUsed : null,
    giftSize: s ? s.giftSize : null,
    giftPackages,
    // TRAE 今日签到(实时接口获得)固化进快照;derive 据此读 signedInToday(卡片/详情展示)
    signedIn: !!(r.checkin && r.checkin.checked_in) ? 1 : 0,
  };
}

/**
 * WorkBuddy 快照条目：把 get-user-resource 的 Accounts[]（积分资源包）转成与 TRAE 同构的快照，
 * giftPackages 字段名对齐 WB 命名(packageName/status/capacityRemain/capacityUsed/capacitySize/cycleEndTime)，
 * 使 deriveGiftExpiry / deriveAccount 的到期/过期/排序派生逻辑直接复用。
 */
function buildWbSnapshotEntry(r) {
  const s = r.summary || {};
  const rd = (r.data && r.data.Accounts) ? r.data : (r.data || {});
  const packs = Array.isArray(rd.Accounts) ? rd.Accounts : [];
  const rawLabels = packs.map((p) => (p.PackageName || "积分").trim());
  const labels = uniqueLabels(rawLabels);
  // 字段选取走 wb.js 的唯一口径（按 CapacityType 声明 + Precise 优先）——
  // 此前这里各写一份"整数优先"的选取，与 wb.js 双写且同错（2026-09-30 收敛）。
  const giftPackages = packs.map((p, i) => {
    const f = pickWbPackFields(p);
    return {
      packageName: labels[i],          // 展示名(含重复编号)
      desc: rawLabels[i],
      status: typeof p.Status === "number" ? p.Status : 0,
      capacityRemain: f.remain,
      capacityUsed: f.used,
      capacitySize: f.size,
      cycleEndTime: p.CycleEndTime || "",
      endTimeS: null,
      // 资源身份（阶段 0，纯增量）：rid@cycleId 唯一确定一个积分资源；
      // kind=quota 表示周期额度包（used 随周期滚动）。供身份引擎后续接账。
      rid: f.rid,
      cycleId: f.cycleId,
      kind: f.kind,
      startAt: f.startAt,
    };
  });
  // WorkBuddy 签到(幂等已签)标记：already / today_checked_in 任一为真即视为已签
  const signed = !!(r.checkin && (r.checkin.already || r.checkin.today_checked_in || r.checkin.checked_in));
  return {
    uin: r.account.uin,
    name: r.account.name,
    displayName: r.account.displayName,
    baseRemain: null,
    baseUsed: null,
    baseSize: null,
    baseCycleEnd: null,
    giftRemain: s.giftRemain != null ? s.giftRemain : null,
    giftUsed: s.giftUsed != null ? s.giftUsed : null,
    giftSize: s.giftSize != null ? s.giftSize : null,
    giftPackages,
    signedIn: signed ? 1 : 0,
    // ⚠️ used 语义版本（格式边界，账本/趋势据此跳过交界那一步，不计成消耗）：
    // v1(缺省) = 读整数 Capacity*（周期额度包为冻结值）；v2 = 按 CapacityType 声明取值 +
    // Precise 优先（wb.pickWbPackFields）。两版 used 基准整体不同 → 交界必须断账一次。
    // 只有 WB 换了口径（TRAE 读数未动），故只 WB 打 scheme:2。
    scheme: 2,
  };
}
