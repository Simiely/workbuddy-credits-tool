// src/compute/model.js - TRAE Work 数据模型（唯一解析口径）
// 把 api.trae.cn 的 user_current_entitlement_list 原始返回解析为统一模型。
// TRAE 结构：
//   usage_summary: { total_amount, consumed_amount, consumption_ratio }  ← 总池口径（唯一权威总消耗）
//   user_entitlement_pack_list: [ { display_desc, status, entitlement_base_info:{currency, quota.credits_limit, end_time, ent_status,...}, usage:{credits_amount} } ]
//     - currency=1 → 通用/可耗积分包（有 credits_limit）
//     - currency=0 → 免费功能包（无 credits_limit，不计入积分）
const sum = (arr, k) => arr.reduce((s, a) => s + (a[k] || 0), 0);

const isCreditable = (p) => (p.entitlement_base_info && p.entitlement_base_info.currency) === 1;
const usedOf = (p) => (p.usage && typeof p.usage.credits_amount === "number" ? p.usage.credits_amount : 0);
const nowS = () => Math.floor(Date.now() / 1000);

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
  const active = credits.filter((p) => p.status === 0 && (p.entitlement_base_info.end_time || 0) > now);
  const expired = credits.filter((p) => !(p.status === 0 && (p.entitlement_base_info.end_time || 0) > now));

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
    return {
      packageName: labels[i],           // 展示名(含重复编号)
      desc: rawLabels[i],
      status: p.status ?? 0,
      capacityRemain: Math.max(0, limit - used),
      capacityUsed: used,
      capacitySize: limit,
      cycleEndTime: bjStr(inf.end_time), // "YYYY-MM-DD HH:mm:ss" 本地串(与 WB 对齐)
      endTimeS: inf.end_time || null,    // 原始秒时间戳(备用)
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
  const num = (v) => {
    const n = typeof v === "string" ? parseFloat(v) : v;
    return typeof n === "number" && Number.isFinite(n) ? n : 0;
  };
  const giftPackages = packs.map((p, i) => {
    const size = p.CapacitySize != null ? num(p.CapacitySize) : num(p.CapacitySizePrecise);
    const used = p.CapacityUsed != null ? num(p.CapacityUsed) : num(p.CapacityUsedPrecise);
    const remain = p.CapacityRemain != null ? num(p.CapacityRemain) : num(p.CapacityRemainPrecise);
    return {
      packageName: labels[i],          // 展示名(含重复编号)
      desc: rawLabels[i],
      status: typeof p.Status === "number" ? p.Status : 0,
      capacityRemain: remain,
      capacityUsed: used,
      capacitySize: size,
      cycleEndTime: p.CycleEndTime || "",
      endTimeS: null,
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
  };
}
