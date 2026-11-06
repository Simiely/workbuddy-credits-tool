// src/store/db.js - 统一时序存储（SQLite 单文件，零依赖，node:sqlite 内置）
//
// 这是「额度遥测管线」的唯一真相源：
//   - accounts  : 账号池（身份 + 凭证），替代原 wb-accounts.json
//   - readings  : 时序快照（append-only，每账号每采样一次一行），替代原 wb-history.json
// 旧的散 JSON 文件仅在首次运行时被导入，之后作为 WebDAV 镜像由 export/import 桥接维护。
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { TOOLS_DIR } from "../config.js";

export const DB_PATH = path.join(TOOLS_DIR, "credits.db");
let _db = null;
let _migrated = false;

/** 进程内单例。首次调用会建表并自动从遗留 JSON 迁移（若库为空）。 */
export function getDb() {
  if (!_db) {
    _db = new DatabaseSync(DB_PATH);
    _db.exec("PRAGMA journal_mode=WAL;");
    _db.exec("PRAGMA busy_timeout=5000;"); // 双进程(GUI+CLI)并发写时等待而非立即 SQLITE_BUSY(2026-08-06 审计加固)
    initSchema(_db);
    ensureMigrated(_db);
  }
  return _db;
}

export function initSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS accounts (
      id TEXT PRIMARY KEY,
      name TEXT,
      uin TEXT,
      cookieHeader TEXT,
      userAgent TEXT,
      sessionExpiresAt TEXT,
      displayName TEXT,
      lastStatus TEXT,
      source TEXT,
      appKey TEXT,
      addedAt TEXT,
      updatedAt TEXT,
      order_idx INTEGER
    );
    CREATE TABLE IF NOT EXISTS readings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      uin TEXT NOT NULL,
      ts TEXT NOT NULL,
      baseRemain REAL,
      baseUsed REAL,
      giftRemain REAL,
      giftUsed REAL,
      raw TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_readings_uin_ts ON readings(uin, ts);
    CREATE TABLE IF NOT EXISTS day_summary (
      uin TEXT NOT NULL,
      day TEXT NOT NULL,
      used REAL NOT NULL DEFAULT 0,
      startRemain REAL,
      endRemain REAL,
      signedIn INTEGER NOT NULL DEFAULT 0,
      fixedAt TEXT,
      PRIMARY KEY (uin, day)
    );
    -- 墓碑表(v1.4.46 同步删除传播):记录"哪个账号在何时被删除"。
    -- 同步合并时:远端账号 updatedAt <= deletedAt → 保持删除(不复活);远端新数据 > deletedAt → 复活。
    -- 只增不删(30 天后由 purgeOldTombstones 清理),不参与账号池查询。
    CREATE TABLE IF NOT EXISTS tombstones (
      uin TEXT PRIMARY KEY,
      deletedAt TEXT NOT NULL
    );
    -- 累计消耗基准(1.6.1 单调水位):记录「截至最后一个已固化日结束」的累计消耗。
    -- 背景:TRAE/WorkBuddy 的 usage_summary.consumed_amount 并非历史累计,它等于
    --   「当前仍存在的积分包的已用之和」——服务端回收过期包时该值会整体回落(实测每次 -100)。
    --   直接拿它当"总消耗"会出现"消耗变少"。故改为 base + 每日正增量:
    --   gc 固化某日时把当日正增量并入 base,derive 时 base + 未固化日增量(不含今日)。
    -- base 只增不减,是累计消耗单调的保证(详见 docs/ 与 derive.js 注释)。
    CREATE TABLE IF NOT EXISTS consumed_baseline (
      uin TEXT PRIMARY KEY,
      base REAL NOT NULL DEFAULT 0,
      -- 基准日:base 已涵盖到哪一天(含)。gc 固化 d 日时仅当 d > asOfDay 才并入,
      -- 否则会把「已包含在 base 里」的历史增量重复累加(实测小黄 base 被抬到 1575 > 真实 1017)。
      asOfDay TEXT,
      updatedAt TEXT
    );
    -- 世代起点（v1.7.2 引入，**v1.8.0 起已废弃**，表保留仅供追溯，代码不再读写）：
    -- 它记录"当前世代"的数据起点，用于隔离「账号删除→重录」的上一世数据。废弃原因是原理性的：
    -- 判别依据是 cum（现存包已用之和）的断崖，而"服务端回收积分包"与"账号重建"在 cum 曲线上
    -- 不可分（回收包里有用过的余额时同形），回收又是常态 → 每次累积到阈值就误判"重建" →
    -- 抛弃锚点与全部日用量 → 累计跳水（2026-09-24 小陈trae 8247.4→3852.56、09-27 小黄trae
    -- 6306.78→2106.78）。现行口径见 src/compute/ledger.js（账本：used 只增，回收进 recycled）。
    CREATE TABLE IF NOT EXISTS epoch_start (
      uin TEXT PRIMARY KEY,
      startDay TEXT NOT NULL,
      base REAL NOT NULL DEFAULT 0,
      reason TEXT,
      detectedAt TEXT
    );
    -- 账号生命周期留痕:删除 / 世代重置。给「重录时连续性判定」提供参照，同时留审计。
    -- removed 事件记删除前最后一条快照的 cum(瞬时累计) 与 size(总发放)：
    --   重录后若 cum 的回落能被 size 的减少解释（积分包消失，等量同掉）→ 同一账号；
    --   若未解释的净回退很大 → 账号重建(v1.7.3)。
    CREATE TABLE IF NOT EXISTS account_lifecycle (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      uin TEXT NOT NULL,
      event TEXT NOT NULL,
      at TEXT NOT NULL,
      cum REAL,
      size REAL,
      note TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_lifecycle_uin_at ON account_lifecycle(uin, at);
    -- 每日账本（v1.8.0 累计消耗模型重写，取代 epoch 世代判定）：
    -- 只用「已用」的逐对相邻快照差分记账（与 src/compute/ledger.js 实现同源）：
    --   已用上升                     → used     消耗（计入累计，只增）
    --   已用下降                     → recycled 记账被撤回（服务端回收积分包）
    --   总发放上升                   → added    到手（签到 / 礼包 / 新包）
    -- 关键：recycled 永远不进 used —— 于是"服务端回收积分包"再也不可能把**已发生过的
    -- 消耗**抹掉（旧模型正是把它误判成"账号重建"，然后抛弃锚点与全部日用量，导致累计
    -- 跳水：2026-09-24 小陈trae 8247.4→3852.56、09-27 小黄trae 6306.78→2106.78）。
    -- ⚠️ 故意不用「剩余下降」当消耗：包被收回时未用完的余额也一起消失 → Δremain<0，
    -- 作废会被误记成消耗；「已用」的下降才是记账被撤回的正确信号（详见 ledger.js 头注释）。
    -- 累计消耗 = consumed_baseline.base（迁移前历史，只写一次）+ Σ ledger(day<今天).used。
    CREATE TABLE IF NOT EXISTS daily_ledger (
      uin TEXT NOT NULL,
      day TEXT NOT NULL,
      used REAL NOT NULL DEFAULT 0,
      added REAL NOT NULL DEFAULT 0,
      recycled REAL NOT NULL DEFAULT 0,
      remainStart REAL,
      remainEnd REAL,
      sizeEnd REAL,
      snaps INTEGER NOT NULL DEFAULT 0,
      fixedAt TEXT,
      PRIMARY KEY (uin, day)
    );
  `);
  ensureColumns(db);
}

// 轻量列迁移：老库缺列时补上（CREATE TABLE IF NOT EXISTS 不会加列）
function ensureColumns(db) {
  try {
    const cols = db.prepare("PRAGMA table_info(day_summary)").all().map((c) => c.name);
    if (!cols.includes("signedIn")) {
      db.exec("ALTER TABLE day_summary ADD COLUMN signedIn INTEGER NOT NULL DEFAULT 0");
    }
  } catch {}
  try {
    const acols = db.prepare("PRAGMA table_info(accounts)").all().map((c) => c.name);
    if (!acols.includes("appKey")) {
      // 存量账号默认归为 traework（本工具当前唯一软件源）
      db.exec("ALTER TABLE accounts ADD COLUMN appKey TEXT");
      db.exec("UPDATE accounts SET appKey='traework' WHERE appKey IS NULL OR appKey=''");
    }
  } catch {}
  try {
    // v1.7.3：生命周期留痕补 size 列（老库无此列时旧行为 size=null，
    // 判定侧自动退回「用参照累计当 size 下界」，不报错）
    const lcols = db.prepare("PRAGMA table_info(account_lifecycle)").all().map((c) => c.name);
    if (!lcols.includes("size")) {
      db.exec("ALTER TABLE account_lifecycle ADD COLUMN size REAL");
    }
  } catch {}
}

// ---------- 遗留数据迁移（首次运行，库为空时自动执行，幂等） ----------

function _readJson(p) {
  try {
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {}
  return null;
}

export function migrateFromLegacy(force = false) {
  const db = getDb();
  if (force) {
    db.prepare("DELETE FROM accounts").run();
    db.prepare("DELETE FROM readings").run();
  }
  const accCount = db.prepare("SELECT COUNT(*) AS c FROM accounts").get().c;
  if (accCount > 0 && !force) return { skipped: true, accounts: accCount };

  const legacyAcc = _readJson(path.join(TOOLS_DIR, "wb-accounts.json"));
  if (legacyAcc && Array.isArray(legacyAcc.accounts)) {
    const ins = db.prepare(
      `INSERT OR REPLACE INTO accounts
        (id,name,uin,cookieHeader,userAgent,sessionExpiresAt,displayName,lastStatus,source,appKey,addedAt,updatedAt,order_idx)
       VALUES (@id,@name,@uin,@cookieHeader,@userAgent,@sessionExpiresAt,@displayName,@lastStatus,@source,@appKey,@addedAt,@updatedAt,@order_idx)`
    );
    legacyAcc.accounts.forEach((a, i) => {
      ins.run({
        id: a.id || `acc${i}`,
        name: a.name || "",
        uin: a.uin || "",
        cookieHeader: a.cookieHeader || "",
        userAgent: a.userAgent || "",
        sessionExpiresAt: a.sessionExpiresAt || null,
        displayName: a.displayName || "",
        lastStatus: a.lastStatus || "ok",
        source: a.source || "legacy",
        appKey: a.appKey || "traework",
        addedAt: a.addedAt || new Date().toISOString(),
        updatedAt: a.updatedAt || new Date().toISOString(),
        order_idx: i,
      });
    });
  }

  const legacyHist = _readJson(path.join(TOOLS_DIR, "wb-history.json"));
  if (legacyHist && Array.isArray(legacyHist.snapshots)) {
    const ins = db.prepare(
      `INSERT INTO readings (uin,ts,baseRemain,baseUsed,giftRemain,giftUsed,raw)
       VALUES (?,?,?,?,?,?,?)`
    );
    for (const snap of legacyHist.snapshots) {
      const entries = snap.entries || [];
      for (const e of entries) {
        ins.run(
          e.uin || "",
          snap.ts,
          e.baseRemain ?? null,
          e.baseUsed ?? null,
          e.giftRemain ?? null,
          e.giftUsed ?? null,
          JSON.stringify(e)
        );
      }
    }
  }
  return {
    skipped: false,
    accounts: db.prepare("SELECT COUNT(*) AS c FROM accounts").get().c,
    readings: db.prepare("SELECT COUNT(*) AS c FROM readings").get().c,
  };
}

function ensureMigrated(db) {
  if (_migrated) return;
  _migrated = true;
  migrateFromLegacy(false);
}
