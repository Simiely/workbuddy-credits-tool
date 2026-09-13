// src/compute/paths.js - 账号凭证路径解析（换机/平台版直读本工具指定登录态根）
//
// 原则：一条直路，不做「抓另一个目录里碰巧同名的槽」那种猜测。
//   本工具只有一个「指定登录态根」：env WB_SLOT_ROOT/TRAE_SLOT_ROOT 优先，否则 TOOLS_DIR/backups/<app>。
//   拉取 / 云同步就把每个槽按标准放这里：workbuddy/<槽>/workbuddy-desktop.info · trae/<槽>/User/globalStorage/storage.json
//   cookieHeader 是失效路径时，只按账号「槽名」确定性拼出 `<指定根>/<槽>/<凭证文件>`，其余根一律不碰。
//   槽名来自账号自已登记的 slotName（扫描入库带），旧记录从 cookieHeader 里 `backups/<app>/<槽>` 段确定性回填。
import fs from "node:fs";
import path from "node:path";
import { WB_INFO_FILE, trailSlotRoot } from "../config.js";
import { readAuthFromStorage } from "./trae-decrypt.js";

/** 槽名清洗：去掉占位名，返回可作目录名的字符串或 "" */
function cleanSlot(v) {
  const s = (v === undefined || v === null ? "" : String(v)).trim();
  if (!s) return "";
  if (s === "TRAE 账号" || s === "WorkBuddy 账号" || s === "TRAE 导出账号") return "";
  return s;
}

/**
 * 账号的槽名——只取确定性来源，不做名称猜测：
 *   1) account.slotName（扫描入库时带上，最可靠）
 *   2) 从现有 cookieHeader 路径取「backups/<app>/<槽>」段的 <槽>（换机后原路径仍在，槽段不变）
 * 取不到返回 ""，由上层给出明确报错，杜绝用 displayName/name 去猜目录。
 * @param {object} account
 * @returns {string} 槽名；取不到返回 ""
 */
export function accountSlotName(account) {
  if (!account) return "";
  const fromField = cleanSlot(account.slotName);
  if (fromField) return fromField;
  const ch = String(account.cookieHeader || "").replace(/\\/g, "/");
  const segs = ch.split("/").filter(Boolean);
  const bi = segs.map((s) => s.toLowerCase()).lastIndexOf("backups");
  if (bi >= 0 && bi + 2 < segs.length) return cleanSlot(segs[bi + 2]);
  return "";
}

/**
 * 按账号来源返回登录态根（单点；env 优先，否则默认 TOOLS_DIR/backups/<app>）。
 * 查询端只读这里，其余桌面切换器路径一律不碰。
 * @param {boolean|string} workbuddy 是否 WorkBuddy 来源（或直接传 appKey）
 */
export function slotRoot(workbuddy) {
  const wb = workbuddy === true || (workbuddy && workbuddy !== "trae" && workbuddy !== "traework");
  return trailSlotRoot(wb);
}

/**
 * 槽内标准凭证文件路径（workbuddy=.info，trae=storage.json）。
 * @param {boolean|string} workbuddy 是否 WorkBuddy 来源
 * @param {string} slot 槽名
 */
export function credentialFile(workbuddy, slot) {
  if (!slot) return "";
  const wb = workbuddy === true || (workbuddy && workbuddy !== "trae" && workbuddy !== "traework");
  const slotDir = path.join(slotRoot(wb), slot);
  return wb ? path.join(slotDir, WB_INFO_FILE) : path.join(slotDir, "User", "globalStorage", "storage.json");
}

/**
 * 解析账号实际可用的凭证路径（直读指定根，无目录扫描、无同名猜测）：
 *   - cookieHeader 已是存在的路径 → 原样返回（本机 / 已在的槽，零改动）
 *   - cookieHeader 是内联 JSON 凭证 → 原样返回，交给上层解析
 *   - 失效路径 → 按账号槽名确定性拼 `<指定根>/<槽>/<凭证文件>` 返回（即使文件不存在也返回，
 *     由上层负责给出清晰的「未同步/缺登录态」提示）
 * @param {object} account 账号池记录(cookieHeader/appKey/slotName/displayName/name)
 * @returns {string} 可用凭证路径（含计算出的槽路径）；无法解析返回 ""
 */
/** 读 WB `.info` 内的账号 uid（唯一稳定身份；displayName/name 常为空，不可靠）。 */
function wbInfoUid(infoPath) {
  try {
    const j = JSON.parse(fs.readFileSync(infoPath, "utf8"));
    const a = j && j.account;
    const u = (a && (a.uid != null ? a.uid : a.userId)) ?? "";
    return u === null || u === undefined ? "" : String(u);
  } catch {
    return "";
  }
}

/** 扫描 WB 指定根下所有槽，建立 uid → 槽内凭证文件 映射（按账号 uid 精确路由）。 */
function scanWbUidMap() {
  const map = new Map();
  const root = slotRoot(true);
  if (!fs.existsSync(root)) return map;
  for (const e of fs.readdirSync(root, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const file = path.join(root, e.name, WB_INFO_FILE);
    if (!fs.existsSync(file)) continue;
    const uid = wbInfoUid(file);
    if (uid && !map.has(uid)) map.set(uid, file);
  }
  return map;
}

/** 按账号 uid 在 WB 指定根内匹配槽凭证；匹配不到返回 ""。 */
function resolveWbByUid(account) {
  const uin = account && account.uin != null ? String(account.uin) : "";
  if (!uin) return "";
  return scanWbUidMap().get(uin) || "";
}

/** 读取 TRAE storage.json 解出的 userId（两程序稳定身份；与账号池 uin 对齐）。 */
function traeUserId(storagePath) {
  try {
    const { auth } = readAuthFromStorage(storagePath);
    const u = auth && auth.userId != null ? String(auth.userId) : "";
    return u || "";
  } catch {
    return "";
  }
}

/** 扫描 TRAE 指定根下所有槽，建立 userId → storage.json 映射（按账号 uid 精确路由）。 */
function scanTraeUidMap() {
  const map = new Map();
  const root = slotRoot(false);
  if (!fs.existsSync(root)) return map;
  for (const e of fs.readdirSync(root, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const file = path.join(root, e.name, "User", "globalStorage", "storage.json");
    if (!fs.existsSync(file)) continue;
    const uid = traeUserId(file);
    if (uid && !map.has(uid)) map.set(uid, file);
  }
  return map;
}

/** 按账号 uid 在 TRAE 指定根内匹配槽凭证；匹配不到返回 ""。 */
function resolveTraeByUid(account) {
  const uin = account && account.uin != null ? String(account.uin) : "";
  if (!uin) return "";
  return scanTraeUidMap().get(uin) || "";
}

/**
 * 解析账号实际可用的凭证路径（直读指定根）：
 *   - cookieHeader 已是存在路径 → 原样返回（本机 / 已在的槽，零改动）
 *   - cookieHeader 是内联 JSON 凭证 → 原样返回，交给上层解析
 *   - 失效路径 → 按槽内凭证的 uid 匹配账号 uin（切换程序槽目录常以手机号/字母命名，
 *     显示名与目录名不可靠，uid 才是两程序一致的稳定身份）；匹配不到再按槽名拼目录兜底。
 * @param {object} account 账号池记录(cookieHeader/appKey/uin/slotName/displayName/name)
 * @returns {string} 可用凭证路径（含计算出的槽路径）；无法解析返回 ""
 */
export function resolveSlotPath(account) {
  const ch = account && typeof account.cookieHeader === "string" ? account.cookieHeader : "";
  if (!ch) return "";
  if (ch.startsWith("{") || ch.startsWith("[")) return ch; // 内联凭证，直接用
  if (fs.existsSync(ch)) return ch; // 本机有效路径，直接用
  const wb = (account && account.appKey) === "workbuddy";
  // WORKBUDDY 与 TRAE 都按 uid 精确路由（两程序稳定身份键）；uid 匹配优先于槽名
  const byUid = wb ? resolveWbByUid(account) : resolveTraeByUid(account);
  if (byUid) return byUid;
  const slot = accountSlotName(account); // 槽名目录兜底（历史记录等）
  if (!slot) return "";
  return credentialFile(wb, slot);
}

// ---- 一键同步时的批量重写（由 webdav.js 编排）：把失效路径确定性重指到本工具指定根 ----
/** 重写失效的 cookieHeader → <指定根>/<槽>/<凭证文件>；返回改写条数。
 * 持久化一律用正斜杠(JSON 转义安全;路径含 \backups 这类字面量遇反斜杠会被 \b 等吞字符),fs 层由上层 path.normalize。 */
export function rewriteAccountPaths(accounts) {
  let n = 0;
  for (const a of accounts) {
    const ch = a && typeof a.cookieHeader === "string" ? a.cookieHeader : "";
    if (!ch || fs.existsSync(ch)) continue;
    if (ch.startsWith("{") || ch.startsWith("[")) continue;
    const target = resolveSlotPath(a); // 与查询同一套解析：WB 按 uid、否则槽名拼目录
    if (target && target !== ch) {
      a.cookieHeader = target.replace(/\\/g, "/"); // 正斜杠持久化,避开 JSON 反斜杠转义
      n++;
    }
  }
  return n;
}