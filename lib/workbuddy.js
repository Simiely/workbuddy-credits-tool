// lib/workbuddy.js - WorkBuddy 网页版内部接口客户端
// 接口无公开文档,是前端页面自身使用的接口;若官方改版需同步调整此处。
import https from "node:https";
import dns from "node:dns";

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
 * HTTPS POST(JSON 请求),IPv4 强制。
 * 为什么强制 IPv4:很多 NAS/家用网络 DNS 返回 AAAA 记录但 IPv6 实际不通,
 * 默认客户端会优先尝试 IPv6 连接并一直挂起直到超时(即常见的"8s 超时")。
 * 用 node:dns.lookup family:4 只连 IPv4,兼容绝大多数环境。
 */
function httpsPost(url, { headers, body, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, {
      method: "POST",
      headers,
      lookup: (host, opts, cb) => dns.lookup(host, { ...opts, family: 4 }, cb),
    }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.setTimeout(timeoutMs, () => req.destroy(Object.assign(new Error("连接超时"), { code: "ETIMEDOUT" })));
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

/**
 * 查询单个账号的积分资源(实时)。
 * @param {string} cookieHeader 登录 cookie(Cookie 请求头格式)
 * @param {number} timeoutMs 超时毫秒(默认 15s,避免接口挂起时无限等待)
 * @returns {Promise<object>} data.Response.Data(Accounts 数组等)
 * @throws {CredentialExpiredError|Error}
 */
export async function fetchCredits(cookieHeader, timeoutMs = 15000) {
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
      throw new Error(`WorkBuddy 接口连接超时(${Math.round(timeoutMs / 1000)}s):请检查 NAS 到 workbuddy.cn 的网络(已强制 IPv4,仍不通多半是 DNS 或防火墙)`);
    }
    const hint = code ? ` [${code}]` : "";
    throw new Error("网络错误" + hint + ": " + e.message);
  }
  if (res.status === 401 || res.status === 403) {
    throw new CredentialExpiredError(`凭证失效(HTTP ${res.status})`, res.status);
  }
  let j;
  try { j = JSON.parse(res.body); } catch {
    throw new Error("接口响应非 JSON(HTTP " + res.status + "):可能是被拦截或接口变更");
  }
  if (j.code !== 0) throw new Error("接口错误: " + (j.msg || JSON.stringify(j)));
  return j.data.Response.Data;
}

/** 校验 cookie 并探测账号标识(Uin) */
export async function probeAccount(cookieHeader) {
  const data = await fetchCredits(cookieHeader);
  const uin = (data.Accounts && data.Accounts[0] && data.Accounts[0].Uin) || "";
  return { data, uin };
}
