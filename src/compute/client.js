// src/compute/client.js - WorkBuddy 网页版内部接口客户端（原 lib/workbuddy.js）
import https from "node:https";
import dns from "node:dns";
import { API, UA, FETCH_TIMEOUT_MS } from "../config.js";

/** 凭证失效(401/403)时抛出的专用错误,调用方可据此标记账号过期 */
export class CredentialExpiredError extends Error {
  constructor(msg, status) {
    super(msg);
    this.name = "CredentialExpiredError";
    this.expired = true;
    this.status = status;
  }
}

// ---------- cookie 清洗(2026-08-06 新增) ----------
// 背景:edge-collector 曾用 Network.getAllCookies 把 workbuddy.cn 域下全部 cookie 拼进 header,
// 混入 Keycloak 一次性登录令牌(KC_RESTART/KC_STATE_CHECKER,单个 1KB+)、广告/埋点跟踪 cookie
// (_gcl_au/sensorsdata/_TDID_CK/trafficParams/qcloud_* 等),且多次登录残留同名 cookie 多份,
// 总长可达 14KB,超过 stgw 网关请求头上限 → HTTP 400 "Request Header Or Cookie Too Large",全部账号查询失败。
// 修复:查询前清洗 —— 剔除已知垃圾 cookie + 同名去重;仍超限则降级为认证核心白名单。
// 实验验证(2026-08-06):认证核心集合(KEYCLOAK_IDENTITY/KEYCLOAK_SESSION/AUTH_SESSION_ID/session/session_2)
// 请求成功(code=0),仅 KEYCLOAK_IDENTITY 会 401。

/** 已知无用且巨大的一次性登录/跟踪 cookie 名前缀(直接剔除) */
const JUNK_COOKIE_PREFIX = [
  "KC_RESTART",       // Keycloak 登录重启令牌(一次性,API 不需要,1KB+)
  "KC_STATE_CHECKER", // Keycloak 状态校验(登录流程用)
  "9c412d6095037d16", // 风控指纹
  "_TDID_CK",         // 腾讯 TDID 跟踪
  "_gcl_au",          // Google 广告
  "trafficParams",    // 流量参数
  "sensorsdata",      // 神策埋点
  "qcloud_",          // 腾讯云埋点(qcloud_from/qcloud_visitId)
  "i18next",          // 国际化语言偏好
  "login_risk_state", // 登录风控状态
];

/** 认证核心 cookie 白名单(验证可用;超长兜底时使用) */
const AUTH_COOKIE_WHITELIST = [
  "KEYCLOAK_IDENTITY",
  "KEYCLOAK_SESSION",
  "AUTH_SESSION_ID",
  "session",
  "session_2",
];

/** stgw 网关请求头约 8KB 上限,留 1KB 余量(Referer/UA 等占位) */
const MAX_COOKIE_BYTES = 7000;

/**
 * 清洗 cookieHeader:剔除垃圾 cookie、同名去重(保留最后一份)、超长降级白名单。
 * 幂等;输入为空/无 ';' 时原样返回,不影响旧格式。
 * @param {string} cookieHeader
 * @returns {string}
 */
export function sanitizeCookieHeader(cookieHeader) {
  if (!cookieHeader || typeof cookieHeader !== "string") return cookieHeader;
  const parts = cookieHeader.split(";").map((s) => s.trim()).filter(Boolean);
  if (!parts.length) return cookieHeader;
  const byName = new Map();
  for (const p of parts) {
    const eq = p.indexOf("=");
    const name = eq > 0 ? p.slice(0, eq) : p;
    if (JUNK_COOKIE_PREFIX.some((j) => name.startsWith(j))) continue;
    byName.set(name, p); // 同名保留最后一份
  }
  let cleaned = [...byName.values()].join("; ");
  if (cleaned.length > MAX_COOKIE_BYTES) {
    cleaned = [...byName.values()]
      .filter((p) => AUTH_COOKIE_WHITELIST.some((n) => p.startsWith(n + "=")))
      .join("; ");
  }
  return cleaned;
}

/**
 * HTTPS POST（JSON 请求），强制 IPv4。
 * 很多 NAS/家用网络 DNS 返回 AAAA 但 IPv6 实际不通，默认会优先 IPv6 挂起超时。
 * 用 dns.lookup family:4 只连 IPv4，兼容绝大多数环境。
 */
function httpsPost(url, { headers, body, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      url,
      {
        method: "POST",
        headers,
        lookup: (host, opts, cb) => dns.lookup(host, { ...opts, family: 4 }, cb),
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
      }
    );
    req.setTimeout(timeoutMs, () =>
      req.destroy(Object.assign(new Error("连接超时"), { code: "ETIMEDOUT" }))
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

/**
 * 查询单个账号的积分资源（实时）。
 * @param {string} cookieHeader 登录 cookie（Cookie 请求头格式）
 * @param {number} timeoutMs 超时毫秒
 * @returns {Promise<object>} data.Response.Data（Accounts 数组等）
 * @throws {CredentialExpiredError|Error}
 */
export async function fetchCredits(cookieHeader, timeoutMs = FETCH_TIMEOUT_MS) {
  cookieHeader = sanitizeCookieHeader(cookieHeader); // 防 400 Cookie Too Large(2026-08-06)
  let res;
  try {
    res = await httpsPost(API, {
      headers: {
        "Content-Type": "application/json",
        Cookie: cookieHeader,
        Referer: "https://www.workbuddy.cn/profile/plans-usage",
        "User-Agent": UA,
      },
      body: "{}",
      timeoutMs,
    });
  } catch (e) {
    const code = e.code;
    if (code === "ETIMEDOUT" || code === "ESOCKETTIMEDOUT") {
      throw new Error(
        `WorkBuddy 接口连接超时(${Math.round(timeoutMs / 1000)}s):请检查 NAS 到 workbuddy.cn 的网络(已强制 IPv4,仍不通多半是 DNS 或防火墙)`
      );
    }
    const hint = code ? ` [${code}]` : "";
    throw new Error("网络错误" + hint + ": " + e.message);
  }
  if (res.status === 401 || res.status === 403) {
    throw new CredentialExpiredError(`凭证失效(HTTP ${res.status})`, res.status);
  }
  let j;
  try {
    j = JSON.parse(res.body);
  } catch {
    throw new Error("接口响应非 JSON(HTTP " + res.status + "):可能是被拦截或接口变更");
  }
  if (j.code !== 0) throw new Error("接口错误: " + (j.msg || JSON.stringify(j)));
  return j.data.Response.Data;
}

/** 校验 cookie 并探测账号标识（Uin） */
export async function probeAccount(cookieHeader) {
  const data = await fetchCredits(cookieHeader);
  const uin = (data.Accounts && data.Accounts[0] && data.Accounts[0].Uin) || "";
  return { data, uin };
}
