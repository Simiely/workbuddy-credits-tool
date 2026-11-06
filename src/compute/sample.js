// src/compute/sample.js - 统一采样入口（审计 #33：单采集、单落盘）
//
// 此前 /api/all（wb-gui.mjs）与 scheduler.js 各自实现「采集 → buildSnapshotEntry → appendSnapshot」，
// 存在重复与漂移风险。现收敛为唯一入口，两条路径共享本函数：
//   - wb-gui.mjs  /api/all   ：前端主动拉取，额外 saveLastData 本地缓存 + 直接 render（不广播，避免与 SSE 刷新风暴）
//   - scheduler.js runOnce   ：后台调度，记录 lastCount/lastError，成功后经 onSampled 驱动 SSE 广播
// 只读路径（如 /api/export.md 生成报告）不走本函数，避免无谓落盘。
import { fetchAllAccounts } from "./query.js";
import { buildSnapshotEntry } from "./model.js";
import { appendSnapshot } from "./history.js";
import { publishSnapshot } from "./publish.js";

/**
 * 执行一次完整采样并落盘快照：采集 fetchAllAccounts → buildSnapshotEntry → appendSnapshot。
 * @param {object}   [opts]
 * @param {function} [opts.onSampled] 快照成功落盘（entries 非空）后回调，形如 (entries, raw) => void。
 *                                    调度器用它驱动 SSE 广播；/api/all 不传（避免刷新风暴）。
 * @returns {Promise<{raw: Array, entries: Array}>}
 *   raw     = fetchAllAccounts 原始结果（含 account/summary/data/error/expired）
 *   entries = 已落盘快照条目（summary 非空者，经 buildSnapshotEntry 归一）
 */
export async function sampleAll({ onSampled = null } = {}) {
  const raw = await fetchAllAccounts();
  const entries = raw.filter((r) => r.summary).map(buildSnapshotEntry);
  if (entries.length) {
    appendSnapshot(entries);
    // v1.8.0：采样后**不再做任何"账号是否被重建"的判定**。原因见 ledger.js 顶部——
    // 「服务端回收积分包」与「账号重建」在 cum 曲线上原理不可分，判错就会抛弃历史、
    // 让累计跳水（这正是 v1.7.2/v1.7.3 补丁反复出问题的根源）。
    // 现行累计口径 = 起点 base + 账本（剩余逐对差分，回收只进 recycled），与"猜"无关；
    // 账本落账在 gc（每天固化 T-1/T-2）里完成，采样这条链路只管落快照。
    // v1.6.0 附属能力：把本次结果推一份精简快照到 WebDAV，供 MultiSwitch 槽卡读取。
    // 刻意 **不 await** —— 发布慢/失败都不得影响采样（函数内部已吞掉全部异常）。
    publishSnapshot({ entries, raw });
    if (typeof onSampled === "function") onSampled(entries, raw);
  }
  return { raw, entries };
}
