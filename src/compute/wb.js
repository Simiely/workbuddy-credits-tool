// src/compute/wb.js - WorkBuddy OAuth 数据源（采集 + 签到/积分查询）
//
// 与 TRAE 来源正交：登录态是明文 JSON(.info)，用 Bearer 令牌调 www.codebuddy.cn。
// 账号.cookieHeader 存「.info 文件绝对路径」，查询时现场读取，不落盘明文 token。
// 签到为幂等：已签返回 code=10001/「已签到」按成功处理，避免重复领取与误报。
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  WB_AUTH_ROOT,
  WB_INFO_FILE,
  WB_DEFAULT_DOMAIN,
  WB_EP_CHECKIN_STATUS,
  WB_EP_DAILY_CHECKIN,
  WB_EP_USAGE,
  FETCH_TIMEOUT_MS,
  UA,
  TOOLS_DIR,
  wbSlotRoots,
} from "../config.js";
import { httpsPostJson, CredentialExpiredError } from "./client.js";

/** 判定账号是否 WorkBuddy 来源（appKey 路由） */
export const isWorkBuddy = (a) => (a && a.appKey) === "workbuddy";

/**
 * 发现全部可用的 WorkBuddy 登录态文件（.info）：
 *   1) 本机 %LOCALAPPDATA%\CodeBuddyExtension\Data\Public\auth
 *   2) MultiSwitch 槽备份（backups/workbuddy/<槽>/ 下递归找 *.info）
 * @returns {Array<{filePath:string, slotName:string|null}>}
 */
export function discoverWbInfoFiles() {
  const out = [];
  const seen = new Set();
  const push = (p, slot) => {
    try {
      const k = fs.realpathSync(p);
      if (seen.has(k)) return;
      seen.add(k);
      out.push({ filePath: k, slotName: slot });
    } catch {}
  };

  // 1) 本机 auth 目录（只取一个：首选 workbuddy-desktop.info，否则最新快照）
  try {
    if (fs.existsSync(WB_AUTH_ROOT)) {
      const _infos = fs.readdirSync(WB_AUTH_ROOT).filter((f) => f.endsWith(".info"));
      if (_infos.length) {
        let sel;
        const canon = _infos.find((f) => f === "workbuddy-desktop.info");
        if (canon) sel = canon;
        else sel = _infos.sort(
          (a, b) => fs.statSync(path.join(WB_AUTH_ROOT, b)).mtimeMs - fs.statSync(path.join(WB_AUTH_ROOT, a)).mtimeMs
        )[0];
        push(path.join(WB_AUTH_ROOT, sel), null);
      }
    }
  } catch {}

  // 2) MultiSwitch 槽备份根（与查询自愈共用 wbSlotRoots:env WB_SLOT_ROOT 优先 + 常见路径 + TOOLS_DIR/backups）
  for (const base of wbSlotRoots()) {
    if (!fs.existsSync(base)) continue;
    // 遍历槽目录：每个槽目录只推**一个**.info（首选 workbuddy-desktop.info，否则最新快照）
    const entries = fs.readdirSync(base, { withFileTypes: true });
    for (const slotEntry of entries) {
      if (!slotEntry.isDirectory()) continue;
      const slotDir = path.join(base, slotEntry.name);
      // 列出本目录全部 .info
      const infos = [];
      const diritems = fs.readdirSync(slotDir, { withFileTypes: true });
      for (const e of diritems) {
        if (!e.isFile() || !e.name.endsWith(".info")) continue;
        infos.push(path.join(slotDir, e.name));
      }
      if (!infos.length) continue;
      // 选法：有规范名则选 workbuddy-desktop.info，否则选最新 mtime
      let sel;
      const candCanon = infos.find(p => path.basename(p) === "workbuddy-desktop.info");
      if (candCanon) sel = candCanon;
      else sel = infos.sort((a,b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
      push(sel, slotEntry.name);
    }
  }
  return out;
}

/**
 * 读取单个 .info 文件 → 实时认证信息。
 * @param {string} filePath workbuddy-desktop.info 绝对路径
 */
export function readWbInfo(filePath) {
  const raw = fs.readFileSync(filePath, "utf8");
  let j;
  try {
    j = JSON.parse(raw);
  } catch {
    throw new Error(`.info 非合法 JSON: ${filePath}`);
  }
  const auth = j.auth || {};
  const acct = j.account || {};
  const accessToken = auth.accessToken || "";
  if (!accessToken) throw new Error(`.info 无 accessToken(未登录): ${filePath}`);
  return {
    accessToken,
    domain: auth.domain || WB_DEFAULT_DOMAIN,
    uid: acct.uid || "",
    nickname: acct.nickname || acct.nickName || "",
    enterpriseId: acct.enterpriseId || acct.enterprise_id || "",
    filePath,
  };
}

/** 构造 WorkBuddy 请求头（Bearer 认证 + 账号归属头） */
function wbHeaders(rec) {
  const h = {
    "Content-Type": "application/json",
    Authorization: "Bearer " + rec.accessToken,
    Accept: "application/json",
    "User-Agent": UA,
  };
  if (rec.uid) h["X-User-Id"] = rec.uid;
  if (rec.domain) h["X-Domain"] = rec.domain;
  if (rec.enterpriseId) {
    h["X-Enterprise-Id"] = rec.enterpriseId;
    h["X-Tenant-Id"] = rec.enterpriseId;
  }
  return h;
}

const base = (rec) => "https://" + (rec.domain || WB_DEFAULT_DOMAIN);

/**
 * 带多拼写回退与幂等解析的 POST。
 * 成功返回 {code, data, msg} 解析后的对象；HTTP 401/403 抛凭证失效。
 */
async function wbPost(rec, endpointList, timeoutMs) {
  let lastErr;
  for (const ep of endpointList) {
    let res;
    try {
      res = await httpsPostJson(base(rec) + ep, {
        headers: wbHeaders(rec),
        body: {},
        timeoutMs,
      });
    } catch (e) {
      lastErr =
        e.code === "ETIMEDOUT" || e.code === "ESOCKETTIMEDOUT"
          ? new Error(`WorkBuddy 接口超时(${(timeoutMs / 1000)}s): ${e.message}`)
          : new Error("网络错误" + (e.code ? ` [${e.code}]` : "") + ": " + e.message);
      continue; // 网络层失败也换拼写重试一次
    }
    if (res.status === 401 || res.status === 403) {
      throw new CredentialExpiredError(`WorkBuddy 凭证失效(HTTP ${res.status}) ${ep}`, res.status);
    }
    if (res.status === 404) {
      lastErr = new Error(`WorkBuddy 端点 404: ${ep}`);
      continue; // 拼写不对 → 换另一个
    }
    let j;
    try {
      j = JSON.parse(res.body);
    } catch {
      lastErr = new Error(`WorkBuddy 响应非 JSON(HTTP ${res.status}): ${ep}`);
      continue;
    }
    return j;
  }
  throw lastErr || new Error("WorkBuddy 请求失败");
}

/** 判断是否为「今日已签到」业务状态（幂等判定依据） */
export function isAlreadyCheckedIn(payload) {
  if (!payload || typeof payload !== "object") return false;
  const code = payload.code;
  const msg = String(payload.msg || payload.message || "");
  if (code === 10001 || /已签到|已经签到/.test(msg)) return true;
  if (typeof payload.today_checked_in === "boolean") return payload.today_checked_in;
  const d = payload.data;
  if (d && typeof d === "object" && typeof d.today_checked_in === "boolean") {
    return d.today_checked_in;
  }
  return false;
}

/** 查询今日签到状态 */
export async function fetchWbCheckinStatus(rec, timeoutMs = FETCH_TIMEOUT_MS) {
  const j = await wbPost(rec, WB_EP_CHECKIN_STATUS, timeoutMs);
  if (j && typeof j === "object" && "data" in j && j.data) return j.data ?? {};
  return j ?? {};
}

/**
 * 领取今日签到（幂等：已签返回 {already:true}，不报错）。
 * @returns {{ok:boolean, already:boolean, credit:number|null, streak:number|null, msg:string}}
 */
export async function fetchWbDailyCheckin(rec, timeoutMs = FETCH_TIMEOUT_MS) {
  const j = await wbPost(rec, WB_EP_DAILY_CHECKIN, timeoutMs);
  if (isAlreadyCheckedIn(j)) {
    return { ok: true, already: true, credit: null, streak: null, msg: deEmbed(`msg`, j) };
  }
  const code = j && typeof j === "object" ? j.code : null;
  if (typeof code === "number" && code !== 0 && code !== 200) {
    return { ok: false, already: false, credit: null, streak: null, msg: deEmbed(`msg`, j) };
  }
  const d = (j && typeof j === "object" && j.data ? j.data : j) ?? {};
  const credit =
    typeof d.today_credit === "number"
      ? d.today_credit
      : typeof d.credit === "number"
        ? d.credit
        : typeof d.points === "number"
          ? d.points
          : null;
  const streak = typeof d.streak_days === "number" ? d.streak_days : null;
  const msg = String(d.message || deEmbed(`msg`, j) || "");
  return { ok: true, already: false, credit, streak, msg: msg.trim() };
}

const deEmbed = (k, j) =>
  j && typeof j === "object" ? String(j[k] || j.errMsg || "") : "";

// ---------- 积分/额度查询（get-user-resource） ----------

const _num = (v) => {
  const n = typeof v === "string" ? parseFloat(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : 0;
};

/**
 * 查询 WorkBuddy 积分额度。
 * 返回解引用后的 data.Response.Data（或 data 兜底）：
 *   { TotalCount, TotalDosage, Accounts:[{PackageName,Status,CapacityRemain/Used/Size,
 *     CycleStartTime,CycleEndTime,ExpiredTime,...}] }
 * 每个 Accounts[] 元素即一个积分资源包。需带 User-Agent（缺则 403 code=10085）。
 */
export async function fetchWbUsage(rec, timeoutMs = FETCH_TIMEOUT_MS) {
  const j = await wbPost(rec, WB_EP_USAGE, timeoutMs);
  const data = (j && typeof j === "object" && j.data) ? j.data : (j || {});
  const rd =
    data.Response && data.Response.Data ? data.Response.Data : data;
  return rd || {};
}

/** 解析 get-user-resource 返回 → 统一模型（对齐 TRAE summarize 的 gift* 口径） */
export function parseWbResources(D) {
  const rd = (D && D.Accounts) ? D : (D || {});
  const packs = Array.isArray(rd.Accounts) ? rd.Accounts : [];
  const credits = packs.map((p) => ({
    PackageCode: p.PackageCode || "",
    PackageName: p.PackageName || "积分",
    ProductName: p.ProductName || "",
    SubProductName: p.SubProductName || "",
    status: typeof p.Status === "number" ? p.Status : 0,
    cycleStart: p.CycleStartTime || "",
    cycleEnd: p.CycleEndTime || "",
    expiredTime: p.ExpiredTime || "",
    // 优先整数值，缺失时用 Precise 小数（同包口径一致）
    size: p.CapacitySize != null ? _num(p.CapacitySize) : _num(p.CapacitySizePrecise),
    used: p.CapacityUsed != null ? _num(p.CapacityUsed) : _num(p.CapacityUsedPrecise),
    remain: p.CapacityRemain != null ? _num(p.CapacityRemain) : _num(p.CapacityRemainPrecise),
    unit: p.CapacityUnit || "credits",
    unlimited: !!p.Unlimited,
    raw: p,
  }));
  // 有效包：Status=0 且周期未结束；否则视为已结束/过期
  const isEnded = (p) =>
    p.status !== 0 ||
    (p.cycleEnd && /^\d{4}-\d{2}-\d{2}/.test(p.cycleEnd) && new Date(p.cycleEnd + "Z").getTime() < Date.now());
  const active = credits.filter((p) => !isEnded(p));
  const expired = credits.filter(isEnded);
  // 总剩余以服务端 TotalDosage 为权威；缺失则累加各包 remain
  const totalRemain = _num(rd.TotalDosage) || credits.reduce((s, p) => s + p.remain, 0);
  const used = credits.reduce((s, p) => s + p.used, 0);
  const activeSize = active.reduce((s, p) => s + p.size, 0);
  const activeUsed = active.reduce((s, p) => s + p.used, 0);
  return {
    raw: rd,
    packs: credits,
    active,
    expired,
    totalRemain,
    totalUsed: used,
    totalSize: totalRemain + used,
    activeSize,
    activeUsed,
    activeRemain: Math.max(0, activeSize - activeUsed),
    giftRemain: totalRemain,
    giftUsed: used,
    giftSize: totalRemain + used,
    giftCount: credits.length,
    expCount: expired.length,
  };
}

/** summarize 口径（与 TRAE summarize 返回同名字段，供 buildSnapshotEntry/渲染统一消费） */
export function summarizeWbResources(D) {
  const m = parseWbResources(D);
  return {
    giftUsed: m.giftUsed,
    giftSize: m.giftSize,
    giftRemain: m.giftRemain,
    giftCount: m.giftCount,
    expCount: m.expCount,
    baseUsed: null,
    baseSize: null,
    baseRemain: null,
    baseCycleEnd: null,
  };
}