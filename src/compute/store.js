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
  db.prepare("DELETE FROM accounts").run();
  const ins = db.prepare(
    `INSERT OR REPLACE INTO accounts
      (id,name,uin,cookieHeader,userAgent,sessionExpiresAt,displayName,lastStatus,source,addedAt,updatedAt,order_idx)
     VALUES (@id,@name,@uin,@cookieHeader,@userAgent,@sessionExpiresAt,@displayName,@lastStatus,@source,@addedAt,@updatedAt,@order_idx)`
  );
  for (let i = 0; i < accounts.length; i++) {
    ins.run(normalizeAccount(accounts[i], i));
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
      JSON.stringify({ updatedAt: new Date().toISOString(), accounts }, null, 2),
      "utf8"
    );
  } catch {}
}

/** 从 wb-accounts.json 镜像导入覆盖 SQLite（供 WebDAV 下载后调用） */
export function importLegacy() {
  try {
    if (!fs.existsSync(ACCOUNTS_FILE)) return;
    const j = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, "utf8"));
    if (!j.accounts || !j.accounts.length) return;
    clearAccounts();
    saveAccounts(j.accounts);
  } catch {}
}
