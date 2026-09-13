// src/compute/discover.js - 账号发现：扫描本机 TRAE 登录态 + MultiSwitch 槽 → 生成账号池候选
import fs from "node:fs";
import path from "node:path";
import { discoverDataRoots } from "../config.js";
import { readAuthFromStorage } from "./trae-decrypt.js";
import { discoverWbInfoFiles, readWbInfo } from "./wb.js";

/**
 * 扫描全部可用登录态（本机 TRAE 目录 + MultiSwitch 槽），每个解密出账号信息。
 * 用于「扫描本机登录态 → 建立账号池」。
 * @returns {Promise<Array<{storage, slotName|null, userId, username, account, deviceId, error?}>>}
 */
export async function scanLocalAuths() {
  const roots = discoverDataRoots();
  const out = [];
  for (const r of roots) {
    try {
      const { auth, deviceId } = readAuthFromStorage(r.storage);
      if (!auth.token) {
        out.push({ storage: r.storage, slotName: r.slotName, error: "无 token(未登录)", userId: null, username: null });
        continue;
      }
      out.push({
        storage: r.storage,
        slotName: r.slotName,
        userId: auth.userId || "",
        username: auth.account?.username || "",
        nickname: auth.account?.nickName || auth.account?.nickname || "",
        deviceId,
        account: auth.account,
        tokenExpAt: auth.expiredAt || null,
      });
    } catch (e) {
      out.push({ storage: r.storage, slotName: r.slotName, error: e.message, userId: null, username: null });
    }
  }
  return out;
}

/** 持久化路径一律正斜杠（JSON 转义安全：反斜杠会触发 \b \n \t \u 等吞字符）；内联 JSON（{ [ 开头）原样不动 */
function toSlash(p) {
  const s = String(p || "");
  if (!s || s.startsWith("{") || s.startsWith("[")) return s;
  return s.replace(/\\/g, "/");
}

/**
 * 生成「账号池候选记录」（供 CLI scan 展示 / import 入库）。
 * @param {object} s scanLocalAuths 的一项
 */
export function toAccountRec(s) {
  const now = new Date().toISOString();
  return {
    name: s.username || s.nickname || s.slotName || "TRAE 账号",
    uin: s.userId || "",
    cookieHeader: toSlash(s.storage),   // TRAE 版语义 = storage.json 路径(正斜杠持久化)
    slotName: s.slotName || "",
    sessionExpiresAt: s.tokenExpAt || null,
    displayName: s.slotName ? `${s.slotName}${s.username ? `(${s.username})` : ""}` : "",
    source: s.slotName ? "slot" : "local",
    lastStatus: s.error ? "error" : "ok",
    addedAt: now,
    updatedAt: now,
  };
}

/** 探测某目录是否就是 TRAE 当前 dataDir（不含槽，避免把当前登录态当槽重复）—— 暂未用，保留语义 */
export function isLocalDataDir(dataRoot) {
  return !dataRoot.includes(path.sep + "backups" + path.sep);
}

/**
 * 把「MultiSwitch 登录态切换器」导出的凭证 json（🔑导出凭证 / export-token）转成账号池记录。
 * 输入的 json 形如 {token, refreshToken?, expiredAt, userId, account:{username,...}, host, userRegion,...}
 * 这类文件缺 storage.json 路径且缺本机文件，无法走「路径现场解密」；
 * 因此把凭证整体封进 cookieHeader（内联 JSON），查询端 readAccountAuth 识别后直接取 token。
 * @param {object} j MultiSwitch 导出的单账号凭证 json
 * @returns {object|null} 账号池记录（可交给 mergeAccountsSmart / saveAccounts）；无法识别返回 null
 */
export function accountFromMultiSwitchExport(j) {
  if (!j || typeof j !== "object" || !j.token) return null;
  const acct = j.account && typeof j.account === "object" ? j.account : {};
  const username = j.username || acct.username || acct.mobile || "";
  const userId = String(j.userId || acct.userId || "");
  const now = new Date().toISOString();
  return {
    // 去重主键（userId）→ uin；无 userId 时退回 username 摘要，保证有值参与合并
    uin: userId || username || "",
    name: username || userId || "TRAE 导出账号",
    // 内联凭证：整个导出对象原样存 cookieHeader，查询时 readAccountAuth 解析出 token
    cookieHeader: JSON.stringify(j),
    sessionExpiresAt: j.expiredAt || null,
    displayName: username || "",
    source: "ms-export", // 来源标记：MultiSwitch 导出凭证
    lastStatus: "ok",
    addedAt: now,
    updatedAt: now,
  };
}

/**
 * 判别某已解析文件对象是否 MultiSwitch 单账号导出（区别于 {accounts:[...]} 账号池快照）。
 * @param {object} obj 已 JSON.parse 的对象
 */
export function isMultiSwitchExport(obj) {
  return !!(obj && typeof obj === "object" && !Array.isArray(obj.accounts) && obj.token && !Array.isArray(obj));
}

// ---------- WorkBuddy 来源：.info 登录态采集 ----------

/**
 * 扫描全部可用的 WorkBuddy .info（本机 auth 目录 + MultiSwitch 槽）。
 * @returns {Promise<Array<{filePath, slotName|null, wb, error?}>>}
 */
export async function scanWbAuths() {
  const out = [];
  for (const f of discoverWbInfoFiles()) {
    try {
      const wb = readWbInfo(f.filePath);
      if (!wb.accessToken) {
        out.push({ ...f, error: "无 accessToken(未登录)", wb: null });
        continue;
      }
      out.push({ ...f, wb });
    } catch (e) {
      out.push({ ...f, error: e.message, wb: null });
    }
  }
  return out;
}

/**
 * 生成 WorkBuddy 账号池记录（供 scan 入库）。appKey=workbuddy，
 * cookieHeader=.info 绝对路径（查询端 readWbInfo 现场读 token，不落盘明文）。
 * @param {object} s scanWbAuths 的一项
 */
export function toWbAccountRec(s) {
  const wb = s.wb || {};
  const now = new Date().toISOString();
  return {
    name: wb.nickname || s.slotName || "WorkBuddy 账号",
    uin: wb.uid || "",
    cookieHeader: toSlash(s.filePath), // 正斜杠持久化
    slotName: s.slotName || "",
    displayName: s.slotName
      ? `${s.slotName}${wb.nickname ? `(${wb.nickname})` : ""}`
      : wb.nickname || "",
    source: s.slotName ? "wb-slot" : "wb-local",
    appKey: "workbuddy",
    lastStatus: s.error ? "error" : "ok",
    addedAt: now,
    updatedAt: now,
    userAgent: "",
    sessionExpiresAt: null,
  };
}
