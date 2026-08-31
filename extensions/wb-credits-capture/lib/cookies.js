// lib/cookies.js — Cookie 清洗(对齐工具 src/compute/client.js sanitizeCookieHeader)
// 背景:workbuddy.cn 登录会残留 KC_RESTART(1KB+ 一次性令牌)/埋点追踪 cookie,
// 多次登录还会残留同名多份,header 总长可超 7KB → 网关 400 Cookie Too Large。
// 扩展自己发 billing 验证请求 + 落库 WebDAV 前都必须清洗,否则扩展内验证直接 400。

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
const AUTH_COOKIE_WHITELIST = [
  "KEYCLOAK_IDENTITY",
  "KEYCLOAK_SESSION",
  "AUTH_SESSION_ID",
  "session",
  "session_2",
];
const MAX_COOKIE_BYTES = 7000; // stgw 网关请求头约 8KB 上限,留 1KB 余量

export function sanitizeCookieHeader(cookieHeader) {
  if (!cookieHeader || typeof cookieHeader !== "string") return cookieHeader;
  const parts = cookieHeader.split(";").map((s) => s.trim()).filter(Boolean);
  if (!parts.length) return cookieHeader;
  const byName = new Map();
  for (const p of parts) {
    const eq = p.indexOf("=");
    const name = eq > 0 ? p.slice(0, eq) : p;
    if (JUNK_COOKIE_PREFIX.some((j) => name.startsWith(j))) continue; // 剔除垃圾
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