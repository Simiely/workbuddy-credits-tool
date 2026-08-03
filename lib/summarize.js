// lib/summarize.js - 积分数据汇总(前后端共用口径)
/**
 * 汇总单个账号的积分数据。
 * @param {object} D data.Response.Data
 * @returns {{
 *   baseUsed,baseSize,baseRemain,baseCycleEnd: number|null,
 *   giftUsed,giftSize,giftRemain,giftCount,expCount: number
 * }}
 */
export function summarize(D) {
  const base = D.Accounts.find((a) => a.PackageName.includes("体验版"));
  const gifts = D.Accounts.filter((a) => !a.PackageName.includes("体验版"));
  const act = gifts.filter((a) => a.Status === 0);
  const exp = gifts.filter((a) => a.Status !== 0);
  const sum = (arr, k) => arr.reduce((s, a) => s + a[k], 0);
  return {
    baseUsed: base ? base.CapacityUsed : null,
    baseSize: base ? base.CapacitySize : null,
    baseRemain: base ? base.CapacityRemain : null,
    baseCycleEnd: base ? base.CycleEndTime : null,
    giftUsed: sum(act, "CapacityUsed"),
    giftSize: sum(act, "CapacitySize"),
    giftRemain: sum(act, "CapacityRemain"),
    giftCount: act.length,
    expCount: exp.length,
  };
}
