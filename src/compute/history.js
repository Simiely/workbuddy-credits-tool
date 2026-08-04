// src/compute/history.js - 本地缓存 + 时序快照（SQLite readings 表，原 lib/history.js）
//
// 设计：每次成功查询产生一个「快照」，旧版把整个快照数组存进 wb-history.json；
// 新版把快照里的每个账号拆成 readings 表里的一行（append-only），快照时间 ts 共享。
// 这样「今日消耗 / 每日序列 / 趋势」都能直接用 SQL 按 uin+ts 聚合，且单一真相源。
// 对外函数签名与旧版一致，buildDashboard 逻辑原样保留（P2 才收口解析）。
import fs from "node:fs";
import path from "node:path";
import { TOOLS_DIR, HISTORY_LIMIT } from "../config.js";
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

/** 把 readings 导出为 wb-history.json 镜像 */
export function exportLegacy() {
  try {
    fs.writeFileSync(
      path.join(TOOLS_DIR, "wb-history.json"),
      JSON.stringify(
        { updatedAt: new Date().toISOString(), snapshots: loadHistory() },
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
    if (!j.snapshots || !j.snapshots.length) return;
    for (const snap of j.snapshots) {
      // 用快照原始 ts 追加(同分钟去重),而非导入时刻——否则历史全挤在当前分钟,且去重后只剩第一条
      appendSnapshot(snap.entries || [], { ts: snap.ts });
    }
  } catch {}
}
