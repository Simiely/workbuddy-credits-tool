// lib/cookies.js - 从 Edge(经代理)获取当前登录的 workbuddy cookie 及相关信息
import { daemonTabs, daemonCmd, daemonEval } from "./daemon.js";

const SESSION_COOKIE_RE = /session/i;

/** 认证 session cookie 的最早过期时间(秒→ISO 字符串) */
function minSessionExpiry(cookies) {
  const exps = cookies
    .filter((c) => SESSION_COOKIE_RE.test(c.name) && c.expires && c.expires > 0)
    .map((c) => c.expires);
  return exps.length ? new Date(Math.min(...exps) * 1000).toISOString() : null;
}

/**
 * 读取当前 Edge 登录态的 workbuddy/codebuddy cookie。
 * @returns {Promise<{cookieHeader: string, sessionExpiresAt: string|null}>}
 * @throws 代理未运行 / 页面不存在 / 未登录
 */
export async function getEdgeCookies() {
  const tabs = await daemonTabs();
  const tab = tabs.find((t) => t.url.includes("workbuddy.cn")) || tabs[0];
  if (!tab) throw new Error("浏览器里没有 workbuddy 页面,请先在 Edge 打开 https://www.workbuddy.cn 并登录");
  const r = await daemonCmd(tab.targetId, "Network.getAllCookies");
  const cookies = (r.result && r.result.cookies || []).filter(
    (c) => c.domain.includes("workbuddy.cn") || c.domain.includes("codebuddy.cn")
  );
  if (!cookies.length) throw new Error("未找到 workbuddy 登录 cookie,请先登录");
  const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
  return { cookieHeader, sessionExpiresAt: minSessionExpiry(cookies) };
}

/** 尝试从 workbuddy 页面文本提取手机号(作为账号名),失败返回空串 */
export async function phoneFromPage() {
  try {
    const tabs = await daemonTabs();
    const idx = tabs.findIndex((t) => t.url.includes("workbuddy.cn"));
    if (idx < 0) return "";
    const expr = "document.body ? (document.body.innerText.match(/1[3-9]\\d{9}/)||[''])[0] : ''";
    return await daemonEval(expr, idx);
  } catch {
    return "";
  }
}
