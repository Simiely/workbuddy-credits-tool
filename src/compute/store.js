// src/compute/store.js - 账号池数据层（SQLite 后端，原 lib/accounts.js + JSON 文件）
//
// 对外签名与旧版完全一致（loadAccounts / saveAccounts / findAccount /
// addOrUpdateAccount / newAccountId / displayName / ACCOUNTS_FILE），
// 仅内部改为读写 SQLite（credits.db）。上层（wb-gui / query / account-ops）无需改动。
import fs from "node:fs";
import path from "node:path";
import { TOOLS_DIR } from "../config.js";
import { getDb } from "../store/db.js";
import { normalizeAccount, rowToAccount } from "../domain.js";

export const ACCOUNTS_FILE = path.join(TOOLS_DIR, "wb-accounts.json"); // 仍保留：WebDAV 镜像 / 兼容清理

/** 读取全部账号（按 order_idx 顺序） */
export function loadAccounts() {
  const db = getDb();
  const rows = db
    .prepare("SELECT * FROM accounts ORDER BY order_idx ASC, id ASC")
    .all();
  return rows.map(rowToAccount);
}

/** 用整个账号数组覆盖写入（调用方持有数组并先改后存，与旧语义一致） */
export function saveAccounts(accounts) {
  const db = getDb();
  // 先清空再写入：否则 INSERT OR REPLACE 只覆盖"仍存在的"行，被删除的账号会残留在表中
  // （导致 /api/del 返回成功、但 /api/all 重读又把已删账号拉回来）。这里才是真正的全量覆盖。
  // 2026-08-06 审计加固：DELETE+INSERT 包事务，中途失败自动回滚，避免半写状态。
  db.exec("BEGIN");
  try {
    db.prepare("DELETE FROM accounts").run();
    const ins = db.prepare(
      `INSERT OR REPLACE INTO accounts
        (id,name,uin,cookieHeader,userAgent,sessionExpiresAt,displayName,lastStatus,source,addedAt,updatedAt,order_idx)
       VALUES (@id,@name,@uin,@cookieHeader,@userAgent,@sessionExpiresAt,@displayName,@lastStatus,@source,@addedAt,@updatedAt,@order_idx)`
    );
    for (let i = 0; i < accounts.length; i++) {
      ins.run(normalizeAccount(accounts[i], i));
    }
    db.exec("COMMIT");
  } catch (e) {
    try { db.exec("ROLLBACK"); } catch {}
    throw e;
  }
}

/** 清空账号池 */
export function clearAccounts() {
  getDb().prepare("DELETE FROM accounts").run();
}

/** 显示名称：优先 displayName，否则手机号/原名称 */
export const displayName = (a) =>
  (a && (a.displayName || "").trim()) || (a && a.name) || "账号";

/**
 * 按 key 查找账号：支持 序号(1 起)、id、Uin
 * @returns {object|undefined}
 */
export function findAccount(accounts, key) {
  const byUin = accounts.find((a) => a.uin && String(a.uin) === String(key));
  if (byUin) return byUin;
  if (/^\d+$/.test(String(key))) {
    const i = parseInt(key, 10) - 1;
    if (accounts[i]) return accounts[i];
    return undefined;
  }
  return accounts.find((a) => a.id === key || a.uin === key);
}

/**
 * 新增或按 Uin 去重更新账号。
 * @returns {{account, isNew: boolean}}
 */
export function addOrUpdateAccount(accounts, rec) {
  const existing = accounts.find((a) => a.uin && rec.uin && a.uin === rec.uin);
  if (existing) {
    Object.assign(existing, rec);
    return { account: existing, isNew: false };
  }
  accounts.push(rec);
  return { account: rec, isNew: true };
}

/** 生成新账号 id */
export function newAccountId() {
  return "acc" + Date.now().toString(36);
}

/**
 * 合并导入的账号到本地池(按 Uin 去重;重复则跳过保留本地,id 冲突重新生成)。
 * (来自远程 1d9f393,供 WebDAV 下载合并账号池使用)
 * @param {Array} local 本地账号池(会被修改)
 * @param {Array} incoming 导入的账号列表
 * @returns {{added: number, skipped: number}}
 */
export function mergeAccounts(local, incoming) {
  let added = 0, skipped = 0;
  for (const inc of incoming) {
    if (!inc || typeof inc !== "object" || !inc.cookieHeader) { skipped++; continue; }
    const dup = local.find((a) => (inc.uin && a.uin === inc.uin) || a.id === inc.id);
    if (dup) { skipped++; continue; }
    local.push({ ...inc, id: newAccountId() }); // 重新生成 id,避免与本地冲突
    added++;
  }
  return { added, skipped };
}

// ---------- WebDAV 镜像桥接（SQLite <-> 遗留 JSON） ----------

/** 把 SQLite 账号池导出为 wb-accounts.json 镜像（供 WebDAV 上传） */
export function exportLegacy() {
  const accounts = loadAccounts();
  try {
    fs.writeFileSync(
      ACCOUNTS_FILE,
      JSON.stringify({ updatedAt: new Date().toISOString(), accounts, tombstones: exportTombstones() }, null, 2),
      "utf8"
    );
  } catch {}
}

/** 从 wb-accounts.json 镜像导入覆盖 SQLite（供 WebDAV 下载后调用） */
export function importLegacy() {
  try {
    if (!fs.existsSync(ACCOUNTS_FILE)) return;
    const j = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, "utf8"));
    // 墓碑恢复（幂等：远端 deletedAt 更新则覆盖，保证删除标记随备份传播）
    if (Array.isArray(j.tombstones) && j.tombstones.length) {
      const db = getDb();
      const ins = db.prepare("INSERT OR REPLACE INTO tombstones (uin, deletedAt) VALUES (?, ?)");
      for (const t of j.tombstones) if (t && t.uin) ins.run(String(t.uin), t.deletedAt || new Date().toISOString());
    }
    if (!j.accounts || !j.accounts.length) return;
    clearAccounts();
    saveAccounts(j.accounts);
  } catch {}
}

// ---------- 墓碑（v1.4.46 同步删除传播） ----------
// 墓碑解决「删除不跨设备」：设备 A 删账号 → tombstones 表记 (uin, deletedAt) →
// 随 wb-accounts.json 备份传播 → 设备 B 同步合并时，远端账号 updatedAt ≤ deletedAt 则保持删除，
// 远端新数据 > deletedAt 则复活。TTL 30 天由 purgeOldTombstones 清理，避免无限膨胀。

const TOMBSTONE_TTL_MS = 30 * 86400000; // 30 天

/** 为指定 uin 写入墓碑（幂等覆盖：重复删除刷新 deletedAt） */
export function tombstoneUins(uins) {
  if (!uins || !uins.length) return;
  const db = getDb();
  const ins = db.prepare("INSERT OR REPLACE INTO tombstones (uin, deletedAt) VALUES (?, ?)");
  const now = new Date().toISOString();
  db.exec("BEGIN");
  try {
    for (const u of new Set(uins)) if (u) ins.run(String(u), now);
    db.exec("COMMIT");
  } catch (e) {
    try { db.exec("ROLLBACK"); } catch {}
    throw e;
  }
}

/** 读全部墓碑：Map<uin, deletedAt(ISO)> */
export function loadTombstones() {
  const rows = getDb().prepare("SELECT uin, deletedAt FROM tombstones").all();
  return new Map(rows.map((r) => [String(r.uin), r.deletedAt]));
}

/** 墓碑导出数组（备份镜像用）：[{uin, deletedAt}] */
export function exportTombstones() {
  return [...loadTombstones().entries()].map(([uin, deletedAt]) => ({ uin, deletedAt }));
}

/** 清理过期墓碑（TTL 30 天），返回清理条数 */
export function purgeOldTombstones(ttlMs = TOMBSTONE_TTL_MS) {
  const cut = new Date(Date.now() - ttlMs).toISOString();
  return getDb().prepare("DELETE FROM tombstones WHERE deletedAt < ?").run(cut).changes;
}

/**
 * smart 合并账号池（v1.4.46 同步用，纯函数可单测）：按 uin 去重，双向取最新 + 墓碑三态。
 * @param {Array} local 本地账号池（会被修改，返回同一数组）
 * @param {Array} incoming 远端备份的账号列表
 * @param {Map<string,string>} [tombstones] uin → deletedAt(ISO)
 * @returns {{added:number, updated:number, skipped:number, tombstoned:number, resurrected:number}}
 *   规则（对齐参考项目 edge-multi-account-cookie 的 smart+墓碑）：
 *   - 远端账号 & 本地无：墓碑 deletedAt ≥ 账号 updatedAt → 保持删除(跳过)；否则导入(有墓碑则视为复活)
 *   - 远端账号 & 本地有：取 updatedAt 更新者（远端新 1s+ → 覆盖；否则保留本地）
 *   - 本地墓碑（本地有活跃账号 & 墓碑存在）：账号 updatedAt ≤ deletedAt → 从本地移除(删除传播)；否则保留(删除不生效，删后又更新过)
 *   - 仅本地有 & 无墓碑：保留
 */
export function mergeAccountsSmart(local, incoming, tombstones = new Map()) {
  const tsOf = (v) => (typeof v === "number" ? v : new Date(v || 0).getTime() || 0);
  let added = 0, updated = 0, skipped = 0, tombstoned = 0, resurrected = 0;

  // 第一步：远端账号合并
  for (const inc of incoming || []) {
    if (!inc || !inc.uin) { skipped++; continue; }
    const key = String(inc.uin);
    const ex = local.find((a) => String(a.uin) === key);
    const tom = tombstones.get(key); // deletedAt(ISO)
    if (!ex) {
      // 本地无：墓碑比账号最后更新还新 → 保持删除（不复活）；否则导入
      // 注意:tom 是 deletedAt(ISO 字符串)本身,直接 tsOf(tom),不是 tom.deletedAt
      if (tom && tsOf(inc.updatedAt) <= tsOf(tom)) { skipped++; continue; }
      const rec = { ...inc, id: inc.id || newAccountId() };
      local.push(rec);
      if (tom) resurrected++; else added++;
      continue;
    }
    // 双方活跃：取 updatedAt 更新者（远端新 1s+ 才覆盖，避免时钟抖动）
    if (tsOf(inc.updatedAt) > tsOf(ex.updatedAt) + 1000) {
      Object.assign(ex, inc, { id: ex.id }); // 保留本地 id（同步不换标识）
      updated++;
    } else {
      skipped++;
    }
  }

  // 第二步：墓碑传播（本地活跃账号 vs 墓碑：删除生效 or 删除不生效）
  for (const [uin, deletedAt] of tombstones) {
    const idx = local.findIndex((a) => String(a.uin) === uin);
    if (idx < 0) continue; // 本地也没有 → 无动作
    const ex = local[idx];
    if (tsOf(ex.updatedAt) <= tsOf(deletedAt)) {
      local.splice(idx, 1); // 删除传播到本地
      tombstoned++;
    }
    // 否则本地 updatedAt > deletedAt：删后又更新过 → 保留本地（删除不生效）
  }

  return { added, updated, skipped, tombstoned, resurrected };
}
