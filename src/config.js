// src/config.js - 全局配置（集中管理路径与常量，TRAE Work(CN) 版）
import path from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";
import fs from "node:fs";

// 路径双兼容：原生 ESM 用 import.meta.url(config.js 在 <root>/src/ 向上跳一级=项目根)
const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, "..");
// 数据目录：默认=项目根；可用环境变量 TRAE_TOOLS_DIR 覆盖（本地预览/测试指向别的实例）
export const TOOLS_DIR = process.env.TRAE_TOOLS_DIR || ROOT;

// ---------- 运行常量 ----------
export const CONCURRENCY = 6;        // 批量查询并发数
export const FETCH_TIMEOUT_MS = 8000; // 单账号请求 TRAE 接口超时（毫秒）
export const GUI_PORT = 8080;        // GUI 服务端口

// ---------- 各软件源「每日签到奖励」(积分) ----------
// 口径来自各源快照实测（勿凭经验上浮）：
//   workbuddy = 100  → 快照 'CodeBuddy…裂变包' capSize=100
//   traework  = 150  → 快照 '签到奖励 N' capSize=150
// 派生「今日到账」按账号 appKey 取常量；appKey 未知/缺省按 traework 计价。
export const SIGNIN_CREDIT = { workbuddy: 100, traework: 150 };
export const DEFAULT_SIGNIN_CREDIT = 150;

// ---------- TRAE 桌面版登录态定位 ----------
// CN 版目录名：TRAE SOLO CN / Trae CN；国际版：TRAE SOLO / Trae。
// 账号池既含「当前本机登录态」也含「MultiSwitch 备份槽」（槽=完整 dataDir 子目录，含 User/globalStorage/storage.json）。
export const TRAE_DIR_NAMES = ["TRAE SOLO CN", "Trae CN", "TRAE SOLO", "Trae"];
export const REL_STORAGE = path.join("User", "globalStorage", "storage.json");

// ---------- 槽根（发现 + 查询自愈共用同一套根,防"能找到但自愈找不到"错位） ----------
// 本工具只有一个「指定登录态根」= env WB_SLOT_ROOT/TRAE_SLOT_ROOT(部署机专有目录,优先),
// 否则默认 TOOLS_DIR/backups/<app>。查询自愈与账号发现必须视同一批根;其余桌面切换器路径一律不碰。
/**
 * 本工具指定登录态根(单点真源,workbuddy/trae 都有各自同名子目录)。
 * @param {boolean} wb 是否 WorkBuddy
 * @returns {string} 指定根(可能不存在,由调用方判断)
 */
export function trailSlotRoot(wb) {
  return (
    (wb ? process.env.WB_SLOT_ROOT : process.env.TRAE_SLOT_ROOT) ||
    path.join(TOOLS_DIR, "backups", wb ? "workbuddy" : "trae")
  );
}
/** WorkBuddy 槽根(目录内各子目录=槽,含 *.info);仅返回存在的目录。 */
export function wbSlotRoots() {
  return existsDirs([trailSlotRoot(true)]);
}
/** TRAE 槽根(目录内各子目录=槽,含 User/globalStorage/storage.json);仅返回存在的目录。 */
export function traeSlotRoots() {
  return existsDirs([trailSlotRoot(false)]);
}
function existsDirs(roots) {
  return roots.filter((r) => {
    try {
      return fs.existsSync(r) && fs.statSync(r).isDirectory();
    } catch {
      return false;
    }
  });
}

/** 可读权限探活，返回存在的目录 */
function _appdata() {
  return (
    process.env.APPDATA ||
    path.join(process.env.USERPROFILE || os.homedir(), "AppData", "Roaming")
  );
}

/**
 * 候选「登录态根」列表：
 *   1) 环境变量 TRAE_STORAGE 显式指向某 storage.json（最高优先，诊断/测试用）
 *   2) 环境变量 TRAE_DATA_ROOT 指向某 dataDir 根（含 User/globalStorage）
 *   3) 本机 AppData 下各 TRAE 目录名
 *   4) MultiSwitch 槽备份根（可从环境变量 TRAE_SLOT_ROOT 或默认路径探测）
 * 返回 { kind, dataRoot, storage, slotName? } 数组（去重后返回存在的）。
 */
export function discoverDataRoots() {
  const out = [];
  const seen = new Set();
  const appdata = _appdata();

  const push = (dataRoot, slotName = null) => {
    if (!dataRoot) return;
    const storage = path.join(dataRoot, REL_STORAGE);
    try {
      if (fs.existsSync(storage)) {
        const k = fs.realpathSync(dataRoot);
        if (!seen.has(k)) {
          seen.add(k);
          out.push({ dataRoot, storage, slotName });
        }
      }
    } catch {}
  };

  // 1) 环境变量单点
  if (process.env.TRAE_STORAGE) {
    try {
      if (fs.existsSync(process.env.TRAE_STORAGE)) {
        out.push({
          dataRoot: path.dirname(path.dirname(path.dirname(process.env.TRAE_STORAGE))),
          storage: process.env.TRAE_STORAGE,
          slotName: null,
        });
        return out;
      }
    } catch {}
  }
  // 2/3) 本机 AppData 各 TRAE 目录
  if (process.env.TRAE_DATA_ROOT) push(process.env.TRAE_DATA_ROOT, null);
  for (const n of TRAE_DIR_NAMES) push(path.join(appdata, n), null);
  // 4) MultiSwitch 槽备份根（与查询自愈共用 traeSlotRoots,防作用域错位）
  for (const base of traeSlotRoots()) {
    try {
      if (!fs.existsSync(base)) continue;
      for (const slot of fs.readdirSync(base)) {
        const slotPath = path.join(base, slot);
        try {
          if (fs.statSync(slotPath).isDirectory()) push(slotPath, slot);
        } catch {}
      }
    } catch {}
  }
  return out;
}

// ---------- WorkBuddy OAuth 数据源 ----------
// 登录态=明文 JSON：%LOCALAPPDATA%\CodeBuddyExtension\Data\Public\auth\workbuddy-desktop.info
// 内含 accessToken + auth.domain(实测为 www.codebuddy.cn，网络流传的 copilot.tencent.com 会 404)。
function _localAppData() {
  return (
    process.env.LOCALAPPDATA ||
    path.join(process.env.USERPROFILE || os.homedir(), "AppData", "Local")
  );
}
export const WB_AUTH_ROOT = path.join(
  _localAppData(),
  "CodeBuddyExtension",
  "Data",
  "Public",
  "auth"
);
export const WB_INFO_FILE = "workbuddy-desktop.info";
export const WB_DEFAULT_DOMAIN = "www.codebuddy.cn"; // 仅当 .info 无 domain 时兜底
// 端点路径带 /v2/（社区交叉实测）；status 有两个拼写并存，规避 404 时自动换。
export const WB_EP_CHECKIN_STATUS = [
  "/v2/billing/meter/checkin-status",
  "/v2/billing/meter/checkin-activity-status",
];
export const WB_EP_DAILY_CHECKIN = ["/v2/billing/meter/daily-checkin"];
// 积分/额度查询（Bearer 现测 200）：返回 data.Response.Data = { TotalCount, TotalDosage, Accounts:[...] }，
// 每个 Accounts[] 元素即一个积分资源包（Status 0=有效/3=结束, CapacitySize/Used/Remain, CycleStart/EndTime）。
// 需带 User-Agent 头（缺则 403 code=10085）；分页不传即默认全量返回（现测 TotalCount=53 一次取全）。
export const WB_EP_USAGE = ["/v2/billing/meter/get-user-resource"];

// ---------- TRAE 云接口（无公开文档，客户端内部接口） ----------
export const API_BASE = "https://api.trae.cn";
export const EP_ENTITLEMENT = "/trae/api/v2/pay/user_current_entitlement_list";
export const EP_CHECKIN = "/trae/api/v2/ug/checkin_credits/status";
export const EP_CHECKIN_CLAIM = "/trae/api/v2/ug/checkin_credits/claim";
// UA 与 Referer/Origin 需与 TRAE 网页端一致（防风控）
export const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
export const REFERER = "https://trae.cn/";
export const ORIGIN = "https://trae.cn";
export const USER_REGION = "cn";
