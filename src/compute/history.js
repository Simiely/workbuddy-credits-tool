// src/compute/history.js - 本地缓存 + 时序快照（SQLite readings 表，原 lib/history.js）
//
// 设计：每次成功查询产生一个「快照」，旧版把整个快照数组存进 wb-history.json；
// 新版把快照里的每个账号拆成 readings 表里的一行（append-only），快照时间 ts 共享。
// 这样「今日消耗 / 每日序列 / 趋势」都能直接用 SQL 按 uin+ts 聚合，且单一真相源。
// 对外函数签名与旧版一致，buildDashboard 逻辑原样保留（P2 才收口解析）。
import fs from "node:fs";
import path from "node:path";
import { TOOLS_DIR } from "../config.js";
import { getDb } from "../store/db.js";

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

// ---------- 消耗仪表盘聚合 ----------
// P2 起：聚合逻辑收口到 src/compute/derive.js（纯函数、单数据源）。
// 本函数只做「账号池 → Derived 视图」的装配，不再内联任何解析公式。
import { deriveAll } from "./derive.js";

/**
 * 由账号池生成消耗仪表盘数据。时序真相源在 readings 表，由 deriveAccount 读取。
 * @param {Array} [_hist] 兼容旧签名（已不再使用，保留避免破坏调用方）
 * @param {Array} accounts 账号池
 */
export function buildDashboard(_hist, accounts) {
  const per = deriveAll(accounts);
  return { per };
}

/** 最新一条 reading 的 ts（用于 dashboard 缓存键，确保刷新后趋势图即时更新） */
export function latestReadingTs() {
  const row = getDb()
    .prepare("SELECT ts FROM readings ORDER BY ts DESC, id DESC LIMIT 1")
    .get();
  return row ? row.ts : "0";
}

// ---------- WebDAV 镜像桥接（SQLite <-> 遗留 JSON） ----------

/** 把 readings + day_summary 导出为 wb-history.json 镜像（固化后旧日只剩摘要，体积骤减） */
export function exportLegacy() {
  try {
    const hist = loadHistory();
    // 剥离历史快照的 giftPackages（单条可 6.5KB 的体积大头；expiring 只读最新快照）——
    // 仅最新一组保留完整，其余组剥离，镜像从 MB 级降到百 KB 级。
    const n = hist.length;
    const slim = hist.map((snap, i) => {
      if (i === n - 1) return snap; // 最新组保留完整字段（含 giftPackages）
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
        saveDaySummary(s.uin, s.day, s.used, s.startRemain, s.endRemain);
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
export function saveDaySummary(uin, day, used, startRemain, endRemain) {
  const db = getDb();
  db.prepare(
    `INSERT INTO day_summary (uin, day, used, startRemain, endRemain, fixedAt)
     VALUES (?,?,?,?,?,?)
     ON CONFLICT(uin, day) DO UPDATE SET used=excluded.used, startRemain=excluded.startRemain,
       endRemain=excluded.endRemain, fixedAt=excluded.fixedAt`
  ).run(uin, day, used ?? 0, startRemain ?? null, endRemain ?? null, new Date().toISOString());
}

/** 读取某账号全部固化摘要（按 day 升序），无则空数组 */
export function loadDaySummaries(uin) {
  const db = getDb();
  return db
    .prepare("SELECT day, used, startRemain, endRemain FROM day_summary WHERE uin=? ORDER BY day ASC")
    .all(uin);
}

/** 读取全部固化摘要（备份镜像用） */
export function loadAllDaySummaries() {
  const db = getDb();
  return db.prepare("SELECT uin, day, used, startRemain, endRemain FROM day_summary ORDER BY uin, day").all();
}

/** 清空固化摘要表（云镜像恢复时先清再导） */
export function clearDaySummaries() {
  const db = getDb();
  db.prepare("DELETE FROM day_summary").run();
}

// ---------- 固化任务的数据访问（计算逻辑在 derive.js 的 gcDaySummaries，避免循环依赖） ----------

const CN_TZ_MS = 8 * 3600 * 1000;

/** 某账号某中国自然日(YYYY-MM-DD)的全部快照（按时间升序） */
export function readingsForDay(uin, day) {
  const db = getDb();
  const startUtc = new Date(day + "T00:00:00Z").getTime() - CN_TZ_MS;
  const endUtc = startUtc + 86400000;
  return db
    .prepare(
      "SELECT ts, baseRemain, baseUsed, giftRemain, giftUsed FROM readings WHERE uin=? AND ts>=? AND ts<? ORDER BY ts ASC"
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
    days.add(new Date(new Date(r.ts).getTime() + CN_TZ_MS).toISOString().slice(0, 10));
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
