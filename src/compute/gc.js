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
import { consumeByPack, detectSignIn } from "./derive.js";
import { dayOfOffset, TZ_MS } from "../time.js";

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
      const rows = readingsForDay(uin, day);
      if (!rows.length) continue;
      const v = consumeByPack(rows);
      const first = rows[0];
      const last = rows[rows.length - 1];
      // 当天签到状态：基线 = 前一天最后一条快照 vs 当日末条,「新增 + 到期日对日=当日+1月」= 当天已签到
      // (基线修正 2026-08-06,与今日签到同因:当日首条可能已含签到包;取不到前一天则退化当日首条)
      const packsOf = (r) => {
        try { return (JSON.parse(r.raw || "{}").giftPackages) || []; } catch { return []; }
      };
      const prevRows = readingsForDay(uin, dayOfOffset(day, -1)); // 前一天快照(可能为空)
      const basePacks = prevRows.length
        ? packsOf(prevRows[prevRows.length - 1])
        : packsOf(first);
      const signedIn = detectSignIn(basePacks, packsOf(last), day) ? 1 : 0;
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
