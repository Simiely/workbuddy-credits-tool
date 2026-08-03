// lib/workbuddy.js - WorkBuddy 网页版内部接口客户端
// 接口无公开文档,是前端页面自身使用的接口;若官方改版需同步调整此处。
export const API = "https://www.workbuddy.cn/billing/meter/get-user-resource";
export const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36 Edg/148.0.0.0";

/** 凭证失效(401/403)时抛出的专用错误,调用方可据此标记账号过期 */
export class CredentialExpiredError extends Error {
  constructor(msg, status) {
    super(msg);
    this.name = "CredentialExpiredError";
    this.expired = true;
    this.status = status;
  }
}

/**
 * 查询单个账号的积分资源(实时)。
 * @param {string} cookieHeader 登录 cookie(Cookie 请求头格式)
 * @param {number} timeoutMs 超时毫秒(默认 15s,避免接口挂起时无限等待)
 * @returns {Promise<object>} data.Response.Data(Accounts 数组等)
 * @throws {CredentialExpiredError|Error}
 */
export async function fetchCredits(cookieHeader, timeoutMs = 15000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(API, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: cookieHeader,
        Referer: "https://www.workbuddy.cn/profile/plans-usage",
        "User-Agent": UA,
      },
      body: "{}",
      signal: ctrl.signal,
    });
  } catch (e) {
    if (e.name === "AbortError") throw new Error("WorkBuddy 接口响应超时(" + Math.round(timeoutMs / 1000) + "s)");
    throw new Error("网络错误: " + e.message);
  } finally {
    clearTimeout(timer);
  }
  if (res.status === 401 || res.status === 403) {
    throw new CredentialExpiredError(`凭证失效(HTTP ${res.status})`, res.status);
  }
  const j = await res.json();
  if (j.code !== 0) throw new Error("接口错误: " + (j.msg || JSON.stringify(j)));
  return j.data.Response.Data;
}

/** 校验 cookie 并探测账号标识(Uin) */
export async function probeAccount(cookieHeader) {
  const data = await fetchCredits(cookieHeader);
  const uin = (data.Accounts && data.Accounts[0] && data.Accounts[0].Uin) || "";
  return { data, uin };
}
