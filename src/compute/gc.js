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
  loadBaseline,
  loadBaselineRow,
  setBaseline,
  maxGiftUsed,
  lastReadingDay,
} from "./history.js";
import { consumeByUsed } from "./derive.js";
import { ledgerFromSnapshots, saveLedgerDay, loadLedger } from "./ledger.js";
import { dayKeyOf, TZ_MS } from "../time.js";

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
  // 明细行 → 账本/摘要所需的形状。固化沿用与实时派生一致的格式感知：readingsForDay 返回的是
  // 裸列（无 unified），不补上的话 consumeByUsed 会把 legacy/unified 混合帧当统一格式，
  // 把格式交界的基准跳变误算为当日消耗并随 day_summary 幂等永久固化（历史旧日混合帧尤其易发）。
  // usedScheme 同理：WB v1(整数 Capacity*)↔v2(按类型声明+Precise) 的 used 基准整体不同，
  // 交界日必须断账（与 historyFor 的推导同规则，raw 只解析一次）。
  const toRow = (r) => {
    let e = {};
    try {
      e = JSON.parse(r.raw || "{}");
    } catch {}
    return {
      ...r,
      unified: Object.prototype.hasOwnProperty.call(e, "giftPackages"),
      usedScheme: e.scheme ?? 1,
    };
  };
  let fixed = 0;
  for (const uin of accts) {
    // 起点初始化（只做一次）：loadBaseline(uin)==null 时以「历史最大瞬时消耗」起步。
    // v1.8.0 起 base 不再逐日并入 —— 账本自己按日累加，base 只是"迁移前历史"的常量
    // （口径见 ledger.js 顶部）。保留这段初始化是为了老库/新账号首次固化时有个合理起点。
    if (loadBaseline(uin) == null) setBaseline(uin, maxGiftUsed(uin), lastReadingDay(uin));
    const existing = new Set(loadDaySummaries(uin).map((s) => s.day)); // 幂等键
    let prevRow = null; // 跨日边界的参照：上一个被处理日的末条快照
    for (const day of oldDayKeys(uin, cutMs)) {
      if (existing.has(day)) continue; // 已固化，跳过
      const rows = readingsForDay(uin, day).map(toRow);
      if (!rows.length) continue;
      // 账本行（v1.8.0 累计口径的唯一来源）：剩余逐对差分 → used/added/recycled
      saveLedgerDay(uin, day, ledgerFromSnapshots(rows, prevRow));
      prevRow = rows[rows.length - 1];
      const v = consumeByUsed(rows); // 日摘要沿用旧口径（面板历史曲线仍读它，累计不再读）
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
    // v1.8.0：把「昨天」也落成账本行。账本模型下 T-1 的消耗必须在 derive 之前入账，
    // 否则要等下一次 gc 才计入（旧模型靠 derive 现算 T-1，账本模型不需要那种特例）。
    // 幂等：已有该日账本行则跳过；跨日边界的参照取「前天末条」（此刻明细仍在）。
    const yday = dayKeyOf(new Date(today0Utc - 86400000).toISOString());
    if (!loadLedger(uin).some((r) => r.day === yday)) {
      const rows = readingsForDay(uin, yday).map(toRow);
      if (rows.length) {
        const pday = dayKeyOf(new Date(today0Utc - 2 * 86400000).toISOString());
        const prows = readingsForDay(uin, pday).map(toRow);
        saveLedgerDay(uin, yday, ledgerFromSnapshots(rows, prows.length ? prows[prows.length - 1] : null));
      }
    }
    // v1.8.0 兜底：用 day_summary 补账本。明细可能已被**上一次** gc 删掉（固化即删），
    // 但摘要还在，而摘要的 used 与账本 used **同源**（都用「已用」的正增量）→ 可直接搬。
    // 只补「起点日之后」的日：起点日及更早都已含在 base 里，再补就是重复累加
    // （旧模型"逐日并入 base"正是在这里出过重复/漏加的边界 bug，v1.7.1 修过一次）。
    const bRow = loadBaselineRow(uin);
    const asOf = bRow && bRow.asOfDay ? String(bRow.asOfDay) : null;
    if (asOf) {
      const have = new Set(loadLedger(uin).map((r) => r.day));
      for (const s of loadDaySummaries(uin)) {
        if (have.has(s.day) || String(s.day) <= asOf) continue;
        saveLedgerDay(uin, s.day, {
          used: s.used ?? 0,
          added: 0,
          recycled: 0,
          remainStart: s.startRemain ?? null,
          remainEnd: s.endRemain ?? null,
          sizeEnd: null,
          snaps: 0,
        });
      }
    }
  }
  // v1.4.68:无论本次是否新增固化,已固化的旧日明细都应清理——否则 day_summary 已有但 readings
  // 残留(陈旧镜像重灌/历史遗留)时 fixed=0 不触发删除,镜像永远不收缩(实测 9.7MB 一直保留)。
  // 循环结束后所有 <cut 的旧日都已进 day_summary(既有或本次新增),删除是安全的;保留 T-1 与今天。
  deleteReadingsBefore(new Date(cutMs).toISOString());
  return { fixed };
}
