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
  `);
  ensureColumns(db);
}

// 轻量列迁移：老库 day_summary 缺 signedIn 列时补上（CREATE IF NOT EXISTS 不会加列）
function ensureColumns(db) {
  try {
    const cols = db.prepare("PRAGMA table_info(day_summary)").all().map((c) => c.name);
    if (!cols.includes("signedIn")) {
      db.exec("ALTER TABLE day_summary ADD COLUMN signedIn INTEGER NOT NULL DEFAULT 0");
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
        (id,name,uin,cookieHeader,userAgent,sessionExpiresAt,displayName,lastStatus,source,addedAt,updatedAt,order_idx)
       VALUES (@id,@name,@uin,@cookieHeader,@userAgent,@sessionExpiresAt,@displayName,@lastStatus,@source,@addedAt,@updatedAt,@order_idx)`
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
