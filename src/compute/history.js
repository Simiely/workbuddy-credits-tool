// src/compute/history.js - 本地缓存 + 时序快照（SQLite readings 表，原 lib/history.js）
//
// 设计：每次成功查询产生一个「快照」，旧版把整个快照数组存进 trae-history.json；
// 新版把快照里的每个账号拆成 readings 表里的一行（append-only），快照时间 ts 共享。
// 这样「今日消耗 / 每日序列 / 趋势」都能直接用 SQL 按 uin+ts 聚合，且单一真相源。
// 派生/仪表盘装配在 derive.js（v1.4.58 起本文件不再 import derive，依赖方向单向）。
// v1.4.58 历史固化(gcDaySummaries)已拆到 gc.js，本文件只提供固化所需的数据访问。
import fs from "node:fs";
import path from "node:path";
import { TOOLS_DIR } from "../config.js";
import { getDb } from "../store/db.js";
import { loadAllLedger, saveLedgerDay } from "./ledger.js"; // v1.8.0 账本（镜像同步用）
import { HISTORY_FILE } from "../store/syncbridge.js";
import { dayKeyOf, TZ_MS } from "../time.js"; // v1.4.58 时区口径统一引用

const LAST_FILE = path.join(TOOLS_DIR, "trae-last-data.json"); // 离线缓存（仍保留为镜像）
const DEDUP_MINUTES = 1;

// ---------- 最近一次结果缓存（JSON 镜像，离线/明细可用） ----------
export function loadLastData() {
  if (!fs.existsSync(LAST_FILE)) return null;
  try {
    const j = JSON.parse(fs.readFileSync(LAST_FILE, "utf8"));
    return j && j.fetchedAt ? j : null;
  } catch {
    return null;
  }
}

export function saveLastData(allResult) {
  try {
    fs.writeFileSync(LAST_FILE, JSON.stringify(allResult, null, 1), "utf8");
  } catch {}
}

export { LAST_FILE };

// ---------- 时序快照（readings 表） ----------

/** 追加一条历史快照：把 entries 拆成多行写入 readings，共享同一 ts。同分钟去重。 */
export function appendSnapshot(entries, opts = {}) {
  if (!entries || !entries.length) return;
  const db = getDb();
  // 默认用当前时间;导入历史镜像时可传 opts.ts 保留快照原始时间(否则全部挤在当前分钟,同分钟去重后只剩第一条)
  const ts = (opts.ts && typeof opts.ts === "string" && opts.ts) || new Date().toISOString();
  const tsMin = ts.slice(0, 16); // 分钟级去重键(基于快照自身 ts,而非"现在")
  const exists = db
    .prepare("SELECT 1 FROM readings WHERE ts LIKE ? LIMIT 1")
    .get(tsMin + "%");
  if (exists) return; // 同一分钟内已有快照，跳过（与旧版行为一致）
  const ins = db.prepare(
    `INSERT INTO readings (uin,ts,baseRemain,baseUsed,giftRemain,giftUsed,raw)
     VALUES (?,?,?,?,?,?,?)`
  );
  // 2026-08-06 审计加固：多行插入包事务，中途失败回滚，避免部分快照
  db.exec("BEGIN");
  try {
    for (const e of entries) {
      ins.run(
        e.uin || "",
        ts,
        e.baseRemain ?? null,
        e.baseUsed ?? null,
        e.giftRemain ?? null,
        e.giftUsed ?? null,
        JSON.stringify(e)
      );
    }
    db.exec("COMMIT");
  } catch (err) {
    try { db.exec("ROLLBACK"); } catch {}
    throw err;
  }
}

/** 清空时序数据 */
export function clearReadings() {
  getDb().prepare("DELETE FROM readings").run();
}

/** 查询某账号的历史（按时间升序），复用旧版字段形状 */
export function historyFor(uin) {
  const db = getDb();
  const rows = db
    .prepare("SELECT ts, raw FROM readings WHERE uin=? ORDER BY ts ASC, id ASC")
    .all(uin);
  return rows
    .map((r) => {
      const e = JSON.parse(r.raw || "{}");
      const baseRemain = e.baseRemain ?? 0;
      const baseUsed = e.baseUsed ?? 0;
      return {
        ts: r.ts,
        baseRemain,
        baseUsed,
        // 快照格式：当前工具统一结构含 giftPackages 键；旧结构(他源合并/老版本)无此键。
        // 同一账号可能既有旧又有新格式快照，consumption 派生据此识别格式切换、避免把基准跳变当消耗。
        unified: Object.prototype.hasOwnProperty.call(e, "giftPackages"),
        // used 语义版本（WB 2026-09-30 换读数字段：v1 整数 Capacity* → v2 按类型声明 +
        // Precise 优先）。v1↔v2 的 used 基准整体不同，账本/趋势交界处必须断账一次。
        usedScheme: e.scheme ?? 1,
        giftUsed: e.giftUsed,
        giftRemain: e.giftRemain,
        totalRemain: (e.giftRemain ?? 0) + baseRemain,
        totalUsed: (e.giftUsed ?? 0) + baseUsed,
        // 赠送包子账号列表（含 CycleEndTime / CapacityRemain / Status）—— P3 起随快照持久化
        giftPackages: Array.isArray(e.giftPackages) ? e.giftPackages : [],
        // 赠送包汇总口径（明细弹窗用，避免前端再依赖实时 r.summary）
        giftSize: e.giftSize ?? null,
        baseSize: e.baseSize ?? null,
        baseCycleEnd: e.baseCycleEnd ?? null,
        // TRAE 今日签到(实时接口固化在快照)
        signedIn: e.signedIn ?? 0,
      };
    })
    .sort((a, b) => (a.ts < b.ts ? -1 : 1));
}

/** 读取全部快照（按 ts 分组，复用旧版 {ts, entries} 形状） */
export function loadHistory() {
  const db = getDb();
  const rows = db
    .prepare("SELECT ts, raw FROM readings ORDER BY ts ASC, id ASC")
    .all();
  const byTs = new Map();
  for (const r of rows) {
    if (!byTs.has(r.ts)) byTs.set(r.ts, []);
    try {
      byTs.get(r.ts).push(JSON.parse(r.raw || "{}"));
    } catch {}
  }
  return [...byTs.entries()].map(([ts, entries]) => ({ ts, entries }));
}

// ---------- 固化任务的数据访问（计算逻辑在 gc.js 的 gcDaySummaries；v1.4.58 拆出，本文件不再 import derive） ----------

/** 最新一条 reading 的 ts（用于 dashboard 缓存键，确保刷新后趋势图即时更新） */
export function latestReadingTs() {
  const row = getDb()
    .prepare("SELECT ts FROM readings ORDER BY ts DESC, id DESC LIMIT 1")
    .get();
  return row ? row.ts : "0";
}

/**
 * 最新一个快照(最大 ts)的逐账号剩余条目，仅读取 baseRemain/giftRemain 列，不解析 raw JSON。
 * 用于 scheduler.computeIntervalMin（自适应采样间隔只需「每个账号最新剩余」），
 * 替代 loadHistory() 的「全表读出 + 逐条 JSON.parse」——数据量大时省去 O(全表) 解析。
 * 返回 [{ uin, baseRemain, giftRemain }]，与 loadHistory().at(-1).entries 的形状对齐。
 */
export function latestSnapshotEntries() {
  const db = getDb();
  const row = db
    .prepare("SELECT ts FROM readings ORDER BY ts DESC, id DESC LIMIT 1")
    .get();
  if (!row) return [];
  return db
    .prepare("SELECT uin, baseRemain, giftRemain FROM readings WHERE ts=?")
    .all(row.ts)
    .map((r) => ({ uin: r.uin, baseRemain: r.baseRemain, giftRemain: r.giftRemain }));
}

// ---------- WebDAV 镜像桥接（SQLite <-> 遗留 JSON） ----------

/** 把 readings + day_summary 导出为 trae-history.json 镜像（固化后旧日只剩摘要，体积骤减） */
export function exportLegacy() {
  try {
    const hist = loadHistory();
    // 剥离策略(v1.4.47 修复):consumeByPack 包级口径需要「每天首条+末条」快照的 giftPackages
    // （只读首末两条,中间快照不用）。原策略只保留最新一组 → 同步/下载恢复后每天首条无包 →
    // 派生自动降级增量口径(今日已用被放大,2026-08-08 实测 321→1169)。新策略:每天首末快照组
    // 保留完整(含 giftPackages),中间组剥离 → 口径不降级,体积几乎不变(每天 100+ 组 → 只 2 组带包)。
    const byDay = new Map(); // day -> {min, max}
    for (const snap of hist) {
      const day = dayKeyOf(snap.ts); // +8 口径统一来自 time.js
      const cur = byDay.get(day);
      if (!cur) byDay.set(day, { min: snap.ts, max: snap.ts });
      else {
        if (snap.ts < cur.min) cur.min = snap.ts;
        if (snap.ts > cur.max) cur.max = snap.ts;
      }
    }
    const keep = new Set();
    for (const { min, max } of byDay.values()) { keep.add(min); keep.add(max); }
    const slim = hist.map((snap) => {
      if (keep.has(snap.ts)) return snap; // 每天首末组保留完整(含 giftPackages)
      const entries = (snap.entries || []).map((e) => {
        const { giftPackages, ...rest } = e;
        return rest;
      });
      return { ...snap, entries };
    });
    fs.writeFileSync(
      HISTORY_FILE,
      JSON.stringify(
        {
          updatedAt: new Date().toISOString(),
          snapshots: slim,
          summaries: loadAllDaySummaries(),
          // v1.8.0：累计口径的两块拼图必须一起同步，否则云恢复后累计会归零/错位 ——
          //   baselines = 起点（迁移前的历史常量）
          //   ledger    = 起点之后的每日账本（used 只增 + added/recycled 分类）
          baselines: loadAllBaselines(),
          ledger: loadAllLedger(),
        },
        null,
        1
      ),
      "utf8"
    );
  } catch {}
}

/** 从 trae-history.json 镜像合并导入 readings（不覆盖本地,保留今天的快照基线;按快照原始 ts 落盘,同分钟去重) */
export function importLegacy() {
  try {
    const p = HISTORY_FILE;
    if (!fs.existsSync(p)) return;
    const j = JSON.parse(fs.readFileSync(p, "utf8"));
    // 累计口径的两块（v1.8.0）：起点 + 账本。先恢复，后面的快照导入不会再改它们。
    // 幂等覆盖：与本地同键则用镜像值（镜像来自本工具导出，方向可信）。
    if (Array.isArray(j.baselines) && j.baselines.length) {
      for (const b of j.baselines) {
        setBaseline(b.uin, b.base ?? 0, b.asOfDay ?? null, true);
      }
    }
    if (Array.isArray(j.ledger) && j.ledger.length) {
      for (const r of j.ledger) saveLedgerDay(r.uin, r.day, r);
    }
    // 固化摘要先恢复（day_summary 幂等覆盖）
    if (Array.isArray(j.summaries) && j.summaries.length) {
      for (const s of j.summaries) {
        saveDaySummary(s.uin, s.day, s.used, s.startRemain, s.endRemain, s.signedIn);
      }
    }
    if (!j.snapshots || !j.snapshots.length) return;
    // v1.4.67:跳过已固化的旧日快照(day_summary 已有该 uin+day),避免陈旧镜像把数据库重新灌满
    // (否则同步下载 → 全量导入 → 上传重导出又变大 → 恶性循环)
    const consolidated = new Set(loadAllDaySummaries().map((s) => s.uin + "|" + s.day));
    for (const snap of j.snapshots) {
      const day = typeof snap.ts === "string" ? dayKeyOf(snap.ts) : null;
      const entries = (snap.entries || []).filter(
        (e) => !day || !consolidated.has((e.uin || "") + "|" + day)
      );
      if (!entries.length) continue;
      // 用快照原始 ts 追加(同分钟去重),而非导入时刻——否则历史全挤在当前分钟,且去重后只剩第一条
      appendSnapshot(entries, { ts: snap.ts });
    }
  } catch {}
}

// ---------- 每日摘要（day_summary 表，历史固化后旧日派生的数据源） ----------

/** 写入/覆盖某账号某日的固化摘要（幂等：重复调用仅覆盖同键） */
export function saveDaySummary(uin, day, used, startRemain, endRemain, signedIn = 0) {
  const db = getDb();
  db.prepare(
    `INSERT INTO day_summary (uin, day, used, startRemain, endRemain, signedIn, fixedAt)
     VALUES (?,?,?,?,?,?,?)
     ON CONFLICT(uin, day) DO UPDATE SET used=excluded.used, startRemain=excluded.startRemain,
       endRemain=excluded.endRemain, signedIn=excluded.signedIn, fixedAt=excluded.fixedAt`
  ).run(uin, day, used ?? 0, startRemain ?? null, endRemain ?? null, signedIn ? 1 : 0, new Date().toISOString());
}

/** 读取某账号全部固化摘要（按 day 升序），无则空数组 */
export function loadDaySummaries(uin) {
  const db = getDb();
  return db
    .prepare("SELECT day, used, startRemain, endRemain, signedIn FROM day_summary WHERE uin=? ORDER BY day ASC")
    .all(uin);
}

/** 读取全部固化摘要（备份镜像用） */
export function loadAllDaySummaries() {
  const db = getDb();
  return db.prepare("SELECT uin, day, used, startRemain, endRemain, signedIn FROM day_summary ORDER BY uin, day").all();
}

/** 清空固化摘要表（云镜像恢复时先清再导） */
export function clearDaySummaries() {
  const db = getDb();
  db.prepare("DELETE FROM day_summary").run();
}

/** 全部累计起点（镜像导出用；口径见 ledger.js —— base 只写一次，是迁移前的历史常量） */
export function loadAllBaselines() {
  return getDb().prepare("SELECT uin, base, asOfDay FROM consumed_baseline").all();
}

/**
 * 读取累计消耗基准(base)：「截至最后一个已固化日结束」的累计消耗。无记录返回 null。
 * 用途见 db.js 中 consumed_baseline 建表注释 —— 服务端 consumed_amount 会因包回收回落，
 * 累计消耗必须靠 base + 每日正增量还原，base 是这条链路的锚。
 */
export function loadBaseline(uin) {
  const r = loadBaselineRow(uin);
  return r && typeof r.base === "number" ? r.base : null;
}

/** 读取整行（含 asOfDay），供需要判断"是否已并入"的调用方使用 */
export function loadBaselineRow(uin) {
  const db = getDb();
  return db.prepare("SELECT base, asOfDay FROM consumed_baseline WHERE uin=?").get(uin) || null;
}

/** 该 uin 最新快照所处的中国自然日（基准日初始化用） */
export function lastReadingDay(uin) {
  const db = getDb();
  const r = db.prepare("SELECT MAX(ts) AS t FROM readings WHERE uin=?").get(uin);
  if (!r || !r.t) return null;
  const d = new Date(r.t);
  return isNaN(d.getTime()) ? null : new Date(d.getTime() + 8 * 3600e3).toISOString().slice(0, 10);
}

/**
 * 把「当日正增量」并入基准（gc 固化某日时调用）。
 * @param {number} delta 当日正增量
 * @param {string} day   该日(YYYY-MM-DD)。
 * @param {number|null} [dayMax] 该日快照里出现过的最大瞬时消耗(giftUsed+baseUsed)。
 *   传入后解锁「初始化当日」的合并（v1.7.1 修复）：
 *   基线初始化发生在当天**中途**（部署时刻 base=当时的最大瞬时消耗，asOfDay=当天），
 *   只覆盖到初始化那一刻；该日剩余时段的消耗原被 `day <= asOfDay` 跳过，
 *   随明细删除一起蒸发（实测坤坤WB -420 / 鲁妈妈WB -84）。
 *   修复口径：day === asOfDay 时 base = max(base, dayMax) —— 包内 giftUsed 单调，
 *   当日最大瞬时值即「截至当日结束」的累计；不与 delta 相加，避免重复计入初始化前部分。
 *   day < asOfDay 仍跳过（初始化覆盖）；day > asOfDay 走 delta 累加（原语义）。
 * @returns {number|null} 并入后的 base
 */
export function bumpBaseline(uin, delta, day, dayMax = null) {
  const row = loadBaselineRow(uin);
  const d = Number(delta) || 0;
  const db = getDb();
  const now = new Date().toISOString();
  if (row && row.asOfDay && day && String(day) < String(row.asOfDay)) return row.base;
  if (row && row.asOfDay && day && String(day) === String(row.asOfDay)) {
    // 初始化当日：base 可能只覆盖到「初始化时刻」，用当日最大瞬时消耗校准。
    if (typeof dayMax === "number" && dayMax > row.base) {
      db.prepare("UPDATE consumed_baseline SET base=?, updatedAt=? WHERE uin=?").run(
        dayMax, now, uin);
      return dayMax;
    }
    return row.base;
  }
  if (d === 0 && typeof dayMax !== "number") return row ? row.base : null;
  db.prepare(
    `INSERT INTO consumed_baseline(uin, base, asOfDay, updatedAt) VALUES(?,?,?,?)
     ON CONFLICT(uin) DO UPDATE SET base = base + excluded.base,
                                    asOfDay = excluded.asOfDay,
                                    updatedAt = excluded.updatedAt`
  ).run(uin, d, day || null, now);
  return loadBaseline(uin);
}

/**
 * 该 uin 历史出现过的最大瞬时消耗（纯 SQL，不加载明细）。
 * 用途：为「累计消耗基准」做首次初始化 —— base 从 0 起会漏掉"包回收后再消耗"的那段增量
 * （只剩水位线托底），以历史最大值起步才能把后续增量正确累加。
 */
export function maxGiftUsed(uin) {
  const db = getDb();
  const r = db.prepare("SELECT MAX(giftUsed) AS m FROM readings WHERE uin=?").get(uin);
  return r && typeof r.m === "number" ? r.m : 0;
}

/**
 * 设定基准（初始化回填 / 迁移用）。
 * @param {string|null} asOfDay 基准已涵盖到哪一天(含)；null 表示不设(后续仍会并入)
 * @param {boolean} force false=仅在该 uin 尚无基准时写入（不覆盖已有水位）；true=强制覆盖
 */
export function setBaseline(uin, base, asOfDay = null, force = false) {
  const db = getDb();
  const v = Number(base) || 0;
  db.prepare(
    force
      ? `INSERT INTO consumed_baseline(uin, base, asOfDay, updatedAt) VALUES(?,?,?,?)
         ON CONFLICT(uin) DO UPDATE SET base = excluded.base,
                                        asOfDay = excluded.asOfDay,
                                        updatedAt = excluded.updatedAt`
      : `INSERT INTO consumed_baseline(uin, base, asOfDay, updatedAt) VALUES(?,?,?,?)
         ON CONFLICT(uin) DO NOTHING`
  ).run(uin, v, asOfDay, new Date().toISOString());
  return loadBaseline(uin);
}

// ---------- 世代起点：已于 v1.8.0 整体删除（保留 epoch_start 表仅供追溯） ----------
// 「账号重建判定 + 逐日并入锚点 + 水位线托底」整套机制已废弃，理由是原理性的：
//   「服务端回收积分包」与「账号被重建」在 cum 曲线上不可分（回收包里有用过的余额时同形），
//   而回收是常态 → 每次累积到阈值就误判重建 → 抛弃锚点与全部日用量 → 累计跳水。
//   现行口径见 src/compute/ledger.js（账本 = 剩余逐对差分，回收只进 recycled，永不抹掉消耗）。

// ---------- 账号生命周期留痕（删除 / 世代重置） ----------

/** 记一条生命周期事件。cum = 事件时刻该账号的瞬时累计；size = 当时总发放（v1.7.3，判定用）。 */
export function logLifecycle(uin, event, cum = null, note = null, size = null) {
  getDb()
    .prepare("INSERT INTO account_lifecycle(uin, event, at, cum, size, note) VALUES(?,?,?,?,?,?)")
    .run(
      uin,
      String(event),
      new Date().toISOString(),
      cum == null ? null : Number(cum),
      size == null ? null : Number(size),
      note
    );
}

/**
 * 最近一条生命周期事件。
 * @param {string} uin
 * @param {string|null} event 传 'removed' 则只看删除事件；null = 任意事件
 */
export function lastLifecycle(uin, event = null) {
  const db = getDb();
  const cols = "event, at, cum, size, note";
  return event
    ? db.prepare(`SELECT ${cols} FROM account_lifecycle WHERE uin=? AND event=? ORDER BY at DESC LIMIT 1`).get(uin, event) || null
    : db.prepare(`SELECT ${cols} FROM account_lifecycle WHERE uin=? ORDER BY at DESC LIMIT 1`).get(uin) || null;
}

/** 全部生命周期事件（审计/排查用，最多 limit 条）。 */
export function loadLifecycle(limit = 200) {
  return getDb()
    .prepare("SELECT uin, event, at, cum, size, note FROM account_lifecycle ORDER BY at DESC LIMIT ?")
    .all(limit);
}

// ---------- 世代判定所需的读数（瞬时累计 / 总发放） ----------

const cumOf = (r) => Number(r.giftUsed || 0) + Number(r.baseUsed || 0);
const sizeOf = (r) => {
  try {
    const j = JSON.parse(r.raw || "{}");
    return Number(j.giftSize || 0) + Number(j.baseSize || 0);
  } catch {
    return 0;
  }
};

/**
 * 某账号最新一条快照的 {ts, cum, size}。无快照返回 null。
 * cum  = giftUsed + baseUsed（瞬时累计消耗）
 * size = giftSize + baseSize（当前总发放）
 * 用途（v1.8.0 起）：账号被删除时记一条留痕（trae-gui 的 /api/del），供事后审计。
 */
export function latestReading(uin) {
  const r = getDb()
    .prepare("SELECT ts, giftUsed, baseUsed, raw FROM readings WHERE uin=? ORDER BY ts DESC LIMIT 1")
    .get(uin);
  if (!r) return null;
  return { ts: r.ts, cum: cumOf(r), size: sizeOf(r) };
}

// cumSeries / maxCumSince 已随世代判定一并删除（v1.8.0）—— 它们只服务于
// 「拿 cum 猜账号重建」，而那套判别原理上不成立，详见 ledger.js 顶部。

// ---------- 固化任务的数据访问（计算逻辑在 derive.js 的 gcDaySummaries，避免循环依赖） ----------

/** 某账号某中国自然日(YYYY-MM-DD)的全部快照（按时间升序，含 raw 供签到检测） */
export function readingsForDay(uin, day) {
  const db = getDb();
  const startUtc = new Date(day + "T00:00:00Z").getTime() - TZ_MS;
  const endUtc = startUtc + 86400000;
  return db
    .prepare(
      "SELECT ts, baseRemain, baseUsed, giftRemain, giftUsed, raw FROM readings WHERE uin=? AND ts>=? AND ts<? ORDER BY ts ASC"
    )
    .all(uin, new Date(startUtc).toISOString(), new Date(endUtc).toISOString());
}

/** 某账号所有「中国日期」早于 cutUtcMs 的日期键（去重升序）——即待固化/待清理的旧日 */
export function oldDayKeys(uin, cutUtcMs) {
  const db = getDb();
  const rows = db
    .prepare("SELECT ts FROM readings WHERE uin=? AND ts < ? ORDER BY ts")
    .all(uin, new Date(cutUtcMs).toISOString());
  const days = new Set();
  for (const r of rows) {
    days.add(dayKeyOf(r.ts)); // +8 口径统一来自 time.js
  }
  return [...days].sort();
}

/** 删除早于给定 ISO 时刻的全部快照（保留窗口内的不动） */
export function deleteReadingsBefore(isoTs) {
  const db = getDb();
  db.prepare("DELETE FROM readings WHERE ts < ?").run(isoTs);
}

/** 所有有快照的账号 uin（固化任务用，不依赖账号池） */
export function allSnapshotUins() {
  const db = getDb();
  return db.prepare("SELECT DISTINCT uin FROM readings").all().map((r) => r.uin);
}
