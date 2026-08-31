// lib/store.js — chrome.storage 读写层 + 常量(配置/备注/账号列表)
// 路径约定(与 wb-credits-tool src/compute/webdav.js 保持一致):
//   远端路径: {base}/workbuddy/workbuddy积分/wb-accounts.json
//   默认 base: http://192.168.2.1:6086

export const DEFAULT_WEBDAV_URL = "http://192.168.2.1:6086";
export const BACKUP_DIR = "workbuddy/workbuddy积分"; // 与工具 BACKUP_DIR 完全一致
export const ACCOUNTS_FILE = "wb-accounts.json";
export const CFG_KEY = "wb_credits_capture_webdav";
export const ACCOUNTS_KEY = "wb_credits_capture_accounts"; // 全部已抓取账号(卡片展示/同步真相源)
export const REMARK_KEY = "wb_credits_capture_remark"; // uin → 备注(用户手动设置,抓取/同步/显示优先用)

export function genId() {
  return "acc" + Math.random().toString(36).slice(2, 10);
}

// ---- 配置 ----
export async function getConfig() {
  const r = await chrome.storage.local.get(CFG_KEY);
  const cfg = r[CFG_KEY] || {};
  return {
    url: String(cfg.url || "").trim() || DEFAULT_WEBDAV_URL,
    user: String(cfg.user || ""),
    pass: String(cfg.pass || ""),
  };
}
export async function saveConfig({ url, user, pass }) {
  await chrome.storage.local.set({
    [CFG_KEY]: { url: String(url || ""), user: String(user || ""), pass: String(pass || "") },
  });
}
/** 读取配置原始存储值(getState 用于展示已填内容,不套默认) */
export async function getRawConfig() {
  const r = await chrome.storage.local.get(CFG_KEY);
  return r[CFG_KEY] || {};
}

// ---- 备注(用户为某账号手动设置的 name)持久化到 chrome.storage,按 uin 记录 ----
export async function loadRemark(uin) {
  const r = await chrome.storage.local.get(REMARK_KEY);
  const map = r[REMARK_KEY] || {};
  const v = map && map[String(uin)];
  return v ? String(v).trim() : "";
}
export async function saveRemark(uin, remark) {
  const r = await chrome.storage.local.get(REMARK_KEY);
  const map = r[REMARK_KEY] || {};
  map[String(uin)] = String(remark || "").trim();
  await chrome.storage.local.set({ [REMARK_KEY]: map });
}

// ---- 全部已抓取账号列表(chrome.storage 持久化;抓取即新增/更新一张卡片) ----
export async function loadAccounts() {
  const r = await chrome.storage.local.get(ACCOUNTS_KEY);
  return Array.isArray(r[ACCOUNTS_KEY]) ? r[ACCOUNTS_KEY] : [];
}
export async function persistAccounts(arr) {
  await chrome.storage.local.set({ [ACCOUNTS_KEY]: arr });
}