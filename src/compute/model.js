// src/compute/model.js - 领域模型（唯一解析口径，消除 3 处重复解析）
// 原 lib/summarize.js 与 lib/render.js、wb-gui.mjs 路由里各自重算 base/gift/active/expired，
// 现在统一在这里解析一次，render / query / GUI 都消费它。
const sum = (arr, k) => arr.reduce((s, a) => s + (a[k] || 0), 0);

/**
 * 把 WorkBuddy 原始返回（data.Response.Data）解析为统一模型。
 * @param {object} D data.Response.Data
 */
export function parseAccountData(D) {
  const accounts = (D && D.Accounts) || [];
  const base = accounts.find((a) => (a.PackageName || "").includes("体验版")) || null;
  const gifts = accounts.filter((a) => !(a.PackageName || "").includes("体验版"));
  const active = gifts.filter((a) => a.Status === 0);
  const expired = gifts.filter((a) => a.Status !== 0);

  const baseRemain = base ? base.CapacityRemain : null;
  const baseUsed = base ? base.CapacityUsed : null;
  const baseSize = base ? base.CapacitySize : null;
  const giftUsed = sum(active, "CapacityUsed");
  const giftSize = sum(active, "CapacitySize");
  const giftRemain = sum(active, "CapacityRemain");

  return {
    raw: accounts,
    base,
    gifts,
    active,
    expired,
    baseRemain,
    baseUsed,
    baseSize,
    baseCycleEnd: base ? base.CycleEndTime : null,
    giftUsed,
    giftSize,
    giftRemain,
    giftCount: active.length,
    expCount: expired.length,
    totalRemain: (baseRemain || 0) + giftRemain,
    totalUsed: (baseUsed || 0) + giftUsed,
  };
}

/**
 * 汇总口径（兼容旧 summarize 字段，供 API/前端取用）。
 * @param {object} D data.Response.Data
 */
export function summarize(D) {
  const m = parseAccountData(D);
  return {
    baseUsed: m.baseUsed,
    baseSize: m.baseSize,
    baseRemain: m.baseRemain,
    baseCycleEnd: m.baseCycleEnd,
    giftUsed: m.giftUsed,
    giftSize: m.giftSize,
    giftRemain: m.giftRemain,
    giftCount: m.giftCount,
    expCount: m.expCount,
  };
}

/** 包名短化（控制台/表格友好） */
export const SHORT_PKG = (n) =>
  (n || "")
    .replace("CodeBuddy个人版国内运营裂变包", "裂变包")
    .replace("CodeBuddy个人体验版", "体验版");

/**
 * 构造一条「快照写入条目」：把本次查询的汇总口径 + 赠送包子账号列表一并打包，
 * 供 history.appendSnapshot 落库（readings 表）。
 *
 * 关键：赠送包子账号列表（含 CycleEndTime / CapacityRemain / Status）随快照持久化，
 * 这样「到期口径」(expiringInDays / 周桶 / 排序紧迫度) 才能在 derive.js 里从单一真相源派生，
 * 前端不再从实时 r.data.Accounts 现算（修复「单派生源漏点」）。
 *
 * @param {{account, data, summary}} r fetchAllAccounts 的单条结果
 */
export function buildSnapshotEntry(r) {
  const s = r.summary || null;
  const accounts = (r.data && r.data.Accounts) || [];
  const giftPackages = accounts
    .filter((a) => !(a.PackageName || "").includes("体验版"))
    .map((a) => ({
      packageName: a.PackageName || "",
      status: a.Status ?? 0,
      capacityRemain: a.CapacityRemain ?? 0,
      capacityUsed: a.CapacityUsed ?? 0,
      capacitySize: a.CapacitySize ?? 0,
      cycleEndTime: a.CycleEndTime || "",
    }));
  return {
    uin: r.account.uin,
    name: r.account.name,
    displayName: r.account.displayName,
    baseRemain: s ? s.baseRemain : null,
    baseUsed: s ? s.baseUsed : null,
    baseSize: s ? s.baseSize : null,
    baseCycleEnd: s ? s.baseCycleEnd : null,
    giftRemain: s ? s.giftRemain : null,
    giftUsed: s ? s.giftUsed : null,
    giftSize: s ? s.giftSize : null,
    giftPackages,
  };
}

