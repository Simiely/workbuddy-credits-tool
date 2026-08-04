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
    if (typeof onSampled === "function") onSampled(entries, raw);
  }
  return { raw, entries };
}
