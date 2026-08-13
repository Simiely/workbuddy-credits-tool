// src/compute/history.js - 本地缓存 + 时序快照（SQLite readings 表，原 lib/history.js）
//
// 设计：每次成功查询产生一个「快照」，旧版把整个快照数组存进 wb-history.json；
// 新版把快照里的每个账号拆成 readings 表里的一行（append-only），快照时间 ts 共享。
// 这样「今日消耗 / 每日序列 / 趋势」都能直接用 SQL 按 uin+ts 聚合，且单一真相源。
// 派生/仪表盘装配在 derive.js（v1.4.58 起本文件不再 import derive，依赖方向单向）。
// v1.4.58 历史固化(gcDaySummaries)已拆到 gc.js，本文件只提供固化所需的数据访问。
import fs from "node:fs";
import path from "node:path";
import { TOOLS_DIR } from "../config.js";
import { getDb } from "../store/db.js";
import { dayKeyOf, TZ_MS } from "../time.js"; // v1.4.58 时区口径统一引用

const LAST_FILE = path.join(TOOLS_DIR, "wb-last-data.json"); // 离线缓存（仍保留为镜像）
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

/** 把 readings + day_summary 导出为 wb-history.json 镜像（固化后旧日只剩摘要，体积骤减） */
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
      path.join(TOOLS_DIR, "wb-history.json"),
      JSON.stringify(
        {
          updatedAt: new Date().toISOString(),
          snapshots: slim,
          summaries: loadAllDaySummaries(),
        },
        null,
        1
      ),
      "utf8"
    );
  } catch {}
}

/** 从 wb-history.json 镜像合并导入 readings（不覆盖本地,保留今天的快照基线;按快照原始 ts 落盘,同分钟去重) */
export function importLegacy() {
  try {
    const p = path.join(TOOLS_DIR, "wb-history.json");
    if (!fs.existsSync(p)) return;
    const j = JSON.parse(fs.readFileSync(p, "utf8"));
    // 固化摘要先恢复（day_summary 幂等覆盖）
    if (Array.isArray(j.summaries) && j.summaries.length) {
      for (const s of j.summaries) {
        saveDaySummary(s.uin, s.day, s.used, s.startRemain, s.endRemain, s.signedIn);
      }
    }
    if (!j.snapshots || !j.snapshots.length) return;
    for (const snap of j.snapshots) {
      // 用快照原始 ts 追加(同分钟去重),而非导入时刻——否则历史全挤在当前分钟,且去重后只剩第一条
      appendSnapshot(snap.entries || [], { ts: snap.ts });
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
