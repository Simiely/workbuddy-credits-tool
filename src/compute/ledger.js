// src/compute/ledger.js - 每日账本（v1.8.0：累计消耗模型重写，取代 epoch 世代判定）
//
// 【为什么整体重写而不是再打补丁】
// 旧模型 =「锚点 base + 世代隔离 + 水位线托底」，目标是解决"服务端回收积分包 →
// consumed_amount（现存包已用之和）整体回落"。但它采用的手段是**猜账号有没有被重建**，
// 而这两件事在 cum 曲线上原理不可分 —— 只要被回收的包里还有用过的余额，两者就同形；
// 偏偏"回收"是常态（derive.js 旧注释自己写着"12 账号/570 快照实测下降 11 次"）。
// 于是回收量累积到阈值 → 判"账号重建" → 抛弃锚点 + 抛弃世代前全部日用量 → 累计跳水：
//   · 2026-09-24 小陈trae 8247.4 → 3852.56
//   · 2026-09-27 小黄trae 6306.78 → 2106.78（用户观测："昨天还是 2w 多，今天变成 1.6w 多"）
// 判定公式里还有一处结构性缺陷：锚点没存 size，只能拿**锚点的 cum 当 size 下界**
//   （`floorSize = prev.size == null ? prev.cum : prev.size`）→ 解释项被系统性低估 →
//   任何一笔回收都会被算成"未解释回退"。
//
// 【新模型】累计口径 = 「已用」的正增量累加（与 day_summary 的 consumeByUsed 同源，
//   这样两者可交叉验证），并按事件分类 —— 不碰任何"账号是不是被重建"的猜测：
//     Δused > 0                     → used     消耗（进累计，只增）
//     Δused < 0                     → recycled 记账被撤回（服务端回收积分包）
//     Δsize > 0                     → added    到手（签到 / 礼包 / 新包）
//   ⇒ 回收只会落进 recycled 这个**展示项**，不可能再把已发生的消耗抹掉。
//
// ⚠️ 为什么不用「剩余下降」当消耗（第一版设计，被回归测试当场否掉）：
//   积分包被服务端收回时，包里**未用完的余额**也会一起消失 → Δremain < 0，
//   于是"作废"会被误记成"消耗"。而"已用"的下降（Δused < 0）才是记账被撤回的正确信号。
//   两者在"包用完了才被收走"时长得一样，只有 used 视角不会把作废算成消耗。
//
// 【口径】累计消耗 = base（consumed_baseline，迁移前的历史值，只写一次）
//                    + Σ ledger(day < 今天).used
//   账本每天一行、幂等（同一天重跑结果相同）；起点之后不再变动，与"猜"彻底脱钩。
import { getDb } from "../store/db.js";

const round2 = (x) => Math.round((Number(x) || 0) * 100) / 100;
// 浮点噪声阈值：数值都是两位小数，<0.005 的变化不算事件
const EPS = 0.005;

/** 快照剩余 = 基础包剩余 + 赠送包剩余（诊断用；不参与累计口径） */
export function snapRemain(row) {
  return round2((Number(row.baseRemain) || 0) + (Number(row.giftRemain) || 0));
}

/** 快照已用 = 基础包已用 + 赠送包已用 —— 累计口径的唯一取值来源 */
export function snapUsed(row) {
  return round2((Number(row.baseUsed) || 0) + (Number(row.giftUsed) || 0));
}

/** 快照总发放 = Σ(每包 剩余+已用)。用来识别「到手」（新包加入）。 */
export function snapSize(row) {
  return round2(snapRemain(row) + snapUsed(row));
}

/** 快照格式：legacy 的 used 会随签到重置，unified 是单调累计 —— 交界处基准整体跳变，不可记账。
 *  usedScheme=2（"unified-v2"）是 WB 2026-09-30 换读数字段后的新口径（按类型声明 + Precise
 *  优先，周期额度包改读 Cycle*）→ 与 v1 的 used 基准整体不同，交界同样断账一次。 */
const fmtOf = (row) => {
  if (!row || !row.unified) return "legacy";
  return row.usedScheme === 2 ? "unified-v2" : "unified";
};

/**
 * 纯函数：一组（同一天、已按时间升序）快照 → 当日账本。
 *
 * @param {Array} rows 快照（需含 baseUsed/giftUsed/baseRemain/giftRemain；unified 可选）
 * @param {object|null} prevRow 前一日（或本日之前）最后一条快照，用于跨日边界的那一步差分；
 *        没有则当日第一步事件不产生记账（宁可少记，不凭空造）
 * @returns {{used:number, added:number, recycled:number,
 *            remainStart:number|null, remainEnd:number|null, sizeEnd:number|null, snaps:number}}
 */
export function ledgerFromSnapshots(rows, prevRow = null) {
  const seq = prevRow ? [prevRow, ...(rows || [])] : (rows || []);
  const out = {
    used: 0,
    added: 0,
    recycled: 0,
    remainStart: null,
    remainEnd: null,
    sizeEnd: null,
    snaps: Math.max(0, seq.length - (prevRow ? 1 : 0)),
  };
  if (!seq.length) return out;
  out.remainStart = snapRemain(seq[0]);
  for (let i = 1; i < seq.length; i++) {
    const p = seq[i - 1];
    const c = seq[i];
    // 格式交界（legacy ↔ unified）：两套 used 语义不同，交界处基准整体跳变
    // （旧随签到重置 / 新为单调累计）→ 刷新基准、不记账（与 consumeByUsed 同源处理）。
    if (fmtOf(p) !== fmtOf(c)) continue;
    const dUsed = round2(snapUsed(c) - snapUsed(p));
    const dSize = round2(snapSize(c) - snapSize(p));
    if (dUsed > EPS) out.used = round2(out.used + dUsed);
    else if (dUsed < -EPS) out.recycled = round2(out.recycled + -dUsed);
    if (dSize > EPS) out.added = round2(out.added + dSize);
  }
  const last = seq[seq.length - 1];
  out.remainEnd = snapRemain(last);
  out.sizeEnd = snapSize(last);
  return out;
}

/** 写入/覆盖某账号某日的账本行（幂等） */
export function saveLedgerDay(uin, day, v) {
  const db = getDb();
  db.prepare(
    `INSERT INTO daily_ledger (uin, day, used, added, recycled, remainStart, remainEnd, sizeEnd, snaps, fixedAt)
     VALUES (?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(uin, day) DO UPDATE SET used=excluded.used, added=excluded.added,
       recycled=excluded.recycled, remainStart=excluded.remainStart, remainEnd=excluded.remainEnd,
       sizeEnd=excluded.sizeEnd, snaps=excluded.snaps, fixedAt=excluded.fixedAt`
  ).run(uin, day, round2(v.used), round2(v.added), round2(v.recycled),
        v.remainStart ?? null, v.remainEnd ?? null, v.sizeEnd ?? null,
        v.snaps || 0, new Date().toISOString());
}

/** 读取某账号的账本（按 day 升序）；beforeDay 给了则只取 day < beforeDay */
export function loadLedger(uin, beforeDay = null) {
  const db = getDb();
  const sql = beforeDay
    ? "SELECT day, used, added, recycled, remainStart, remainEnd, sizeEnd, snaps FROM daily_ledger WHERE uin=? AND day<? ORDER BY day ASC"
    : "SELECT day, used, added, recycled, remainStart, remainEnd, sizeEnd, snaps FROM daily_ledger WHERE uin=? ORDER BY day ASC";
  return beforeDay ? db.prepare(sql).all(uin, beforeDay) : db.prepare(sql).all(uin);
}

/** 读取全部账本行（备份镜像用） */
export function loadAllLedger() {
  return getDb()
    .prepare("SELECT uin, day, used, added, recycled, remainStart, remainEnd, sizeEnd, snaps FROM daily_ledger ORDER BY uin, day")
    .all();
}

/** 清空账本（云镜像恢复时先清再导） */
export function clearLedger() {
  getDb().prepare("DELETE FROM daily_ledger").run();
}

/**
 * 累计消耗（截至 beforeDay 之前，不含 beforeDay）= 起点 + Σ 账本 used。
 * 这就是**唯一的**累计口径：单调、不受服务端回收影响（回收只进 recycled）。
 */
export function ledgerConsumed(uin, beforeDay, base = 0) {
  const rows = loadLedger(uin, beforeDay);
  const sum = rows.reduce((x, r) => x + (Number(r.used) || 0), 0);
  return round2((Number(base) || 0) + sum);
}

/** 汇总某账号账本里的到手 / 被收回（展示与排查用） */
export function ledgerTotals(uin, beforeDay = null) {
  const rows = loadLedger(uin, beforeDay);
  return {
    added: round2(rows.reduce((x, r) => x + (Number(r.added) || 0), 0)),
    recycled: round2(rows.reduce((x, r) => x + (Number(r.recycled) || 0), 0)),
    days: rows.length,
  };
}
