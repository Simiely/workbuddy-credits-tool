// lib/accounts.js - 账号池数据层(唯一读写 wb-accounts.json 的地方)
import fs from "node:fs";
import path from "node:path";
import { TOOLS_DIR } from "./util.js";

export const ACCOUNTS_FILE = path.join(TOOLS_DIR, "wb-accounts.json");
const LEGACY_COOKIE_FILE = path.join(TOOLS_DIR, "wb-cookies.json"); // 旧版单账号文件,首次自动迁移

/**
 * 读取账号池。优先 wb-accounts.json;若不存在则从旧版 wb-cookies.json 迁移。
 * @returns {Array<{id,name,uin,cookieHeader,sessionExpiresAt,displayName?,lastStatus?}>}
 */
export function loadAccounts() {
  if (fs.existsSync(ACCOUNTS_FILE)) {
    const j = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, "utf8"));
    if (j.accounts && j.accounts.length) return j.accounts;
  }
  if (fs.existsSync(LEGACY_COOKIE_FILE)) {
    const c = JSON.parse(fs.readFileSync(LEGACY_COOKIE_FILE, "utf8"));
    return [{ id: "acc1", name: "账号1", uin: "", cookieHeader: c.cookieHeader, sessionExpiresAt: c.sessionExpiresAt || null, lastStatus: "ok" }];
  }
  return [];
}

/** 持久化账号池 */
export function saveAccounts(accounts) {
  fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify({ updatedAt: new Date().toISOString(), accounts }, null, 2), "utf8");
}

/** 显示名称:优先 displayName,否则手机号/原名称 */
export const displayName = (a) => (a && (a.displayName || "").trim()) || (a && a.name) || "账号";

/**
 * 按 key 查找账号:支持 序号(1 起)、id、Uin
 * @returns {object|undefined}
 */
export function findAccount(accounts, key) {
  // 先精确匹配 uin(纯数字 uin 常见,如 330105530346,不能误当序号)
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
    Object.assign(existing, rec); // 保留 displayName/addedAt(rec 中未提供的字段)
    return { account: existing, isNew: false };
  }
  accounts.push(rec);
  return { account: rec, isNew: true };
}

/** 生成新账号 id */
export function newAccountId() {
  return "acc" + Date.now().toString(36);
}
