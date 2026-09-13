// src/compute/gc.js - 历史固化（v1.4.58 从 derive.js 拆出，解除 derive↔history 循环依赖）
//
// 把「T-2 及更早」的每日原始快照压缩为 day_summary 摘要，然后删除原始明细，
// 防止历史无限增长（原 wb-history.json 3.8MB 上传慢的根因）。
// 幂等：某日摘要已存在则跳过；保留窗口 = 昨天(T-1)与今天（todayUsed/dailyUsed 现算需要）。
//
// 依赖方向（单向，无环）：gc → derive（consumeByPack/detectSignIn 纯函数）
//                        gc → history（固化所需的数据访问）
//                        gc → time（+8 口径）
import {
  saveDaySummary,
  loadDaySummaries,
  readingsForDay,
  oldDayKeys,
  deleteReadingsBefore,
  allSnapshotUins,
} from "./history.js";
import { consumeByUsed } from "./derive.js";
import { TZ_MS } from "../time.js";

/**
 * 固化 T-2 及更早（幂等：day_summary 已有该日即跳过）。
 * @returns {{fixed:number}} 本次固化天数（>0 时才会清理对应旧明细）
 */
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
      const rows = readingsForDay(uin, day).map((r) => ({
        ...r,
        // 固化沿用与实时派生一致的格式感知：readingsForDay 返回的是裸列（无 unified），
        // 不补上的话 consumeByUsed 会把 legacy/unified 混合帧当统一格式，把格式交界的
        // 基准跳变误算为当日消耗并随 day_summary 幂等永久固化（历史旧日混合帧尤其易发）。
        unified: (() => {
          try {
            return Object.prototype.hasOwnProperty.call(JSON.parse(r.raw || "{}"), "giftPackages");
          } catch {
            return false;
          }
        })(),
      }));
      if (!rows.length) continue;
      const v = consumeByUsed(rows); // TRAE 消耗 = 当日首末 giftUsed 差(usage_summary 权威)
      const first = rows[0];
      const last = rows[rows.length - 1];
      // TRAE 签到由实时 checkin 接口提供,固化不做元数据推断;历史签到置 0(留待接口化扩展)。
      const signedIn = 0;
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
  // v1.4.68:无论本次是否新增固化,已固化的旧日明细都应清理——否则 day_summary 已有但 readings
  // 残留(陈旧镜像重灌/历史遗留)时 fixed=0 不触发删除,镜像永远不收缩(实测 9.7MB 一直保留)。
  // 循环结束后所有 <cut 的旧日都已进 day_summary(既有或本次新增),删除是安全的;保留 T-1 与今天。
  deleteReadingsBefore(new Date(cutMs).toISOString());
  return { fixed };
}
