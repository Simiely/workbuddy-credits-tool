// src/compute/client.js - TRAE 云接口客户端（api.trae.cn，JWT 认证）
import https from "node:https";
import dns from "node:dns";
import {
  API_BASE, EP_ENTITLEMENT, EP_CHECKIN, EP_CHECKIN_CLAIM,
  UA, REFERER, ORIGIN, USER_REGION, FETCH_TIMEOUT_MS,
} from "../config.js";

/** 凭证失效(401/403/权限类)时抛出的专用错误 */
export class CredentialExpiredError extends Error {
  constructor(msg, status) {
    super(msg);
    this.name = "CredentialExpiredError";
    this.expired = true;
    this.status = status;
  }
}

/**
 * HTTPS POST（JSON），强制 IPv4。
 * 避免 NAS/家用网络 IPv6 实际不通导致挂起。
 * @returns {Promise<{status:number, body:string}>}
 */
export function httpsPostJson(url, { headers, body, timeoutMs }) {
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
        res.on("end", () =>
          resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString("utf8") })
        );
      }
    );
    req.setTimeout(timeoutMs, () =>
      req.destroy(Object.assign(new Error("连接超时"), { code: "ETIMEDOUT" }))
    );
    req.on("error", reject);
    req.write(JSON.stringify(body || {}));
    req.end();
  });
}

/** 构造统一请求头（JWT 认证 + 风控头） */
function _headers(token, deviceId, extra = {}) {
  return {
    "Content-Type": "application/json",
    Authorization: "Cloud-IDE-JWT " + token,
    "X-User-Region": USER_REGION,
    "x-device-id": deviceId || "",
    Referer: REFERER,
    Origin: ORIGIN,
    "User-Agent": UA,
    Accept: "application/json, text/plain, */*",
    ...extra,
  };
}

/** 解析响应：code/成功字段兼容处理。TRAE 返回多为 {code:0?, data:{...}} 或直接 {checked_in,...} */
function _parse(res, endpoint) {
  if (res.status === 401 || res.status === 403) {
    throw new CredentialExpiredError(`凭证失效(HTTP ${res.status})`, res.status);
  }
  let j;
  try {
    j = JSON.parse(res.body);
  } catch {
    throw new Error(`接口响应非 JSON(HTTP ${res.status}): ${endpoint} 可能被拦截或变更`);
  }
  // TRAE 顶层多为 { data: {...} } 或业务字段平铺；code!=0 视为业务错误
  if (typeof j === "object" && j !== null && typeof j.code === "number" && j.code !== 0 && !("data" in j)) {
    throw new Error(`接口错误: ${j.msg || JSON.stringify(j)}`);
  }
  return j;
}

/**
 * 查询积分权益（entitlement pack 列表 + usage_summary）。
 * @param {string} token JWT
 * @param {string} deviceId 设备 id（风控头）
 * @returns {Promise<object>} 业务对象：{usage_summary, user_entitlement_pack_list, ...}
 */
export async function fetchEntitlement(token, deviceId, timeoutMs = FETCH_TIMEOUT_MS) {
  let res;
  try {
    res = await httpsPostJson(API_BASE + EP_ENTITLEMENT, {
      headers: _headers(token, deviceId),
      body: {},
      timeoutMs,
    });
  } catch (e) {
    if (e.code === "ETIMEDOUT" || e.code === "ESOCKETTIMEDOUT") {
      throw new Error(
        `TRAE 接口连接超时(${Math.round(timeoutMs / 1000)}s):请检查到 api.trae.cn 的网络(已强制 IPv4)`
      );
    }
    const hint = e.code ? ` [${e.code}]` : "";
    throw new Error("网络错误" + hint + ": " + e.message);
  }
  const j = _parse(res, EP_ENTITLEMENT);
  // 返回形如 { data: {...} }；优先取 data
  if (j && typeof j === "object" && "data" in j && j.data !== undefined) {
    return j.data ?? {};
  }
  return j ?? {};
}

/**
 * 查询今日签到状态。
 * @returns {Promise<object>} {checked_in, credits, streak_days, ...}
 */
export async function fetchCheckin(token, deviceId, timeoutMs = FETCH_TIMEOUT_MS) {
  let res;
  try {
    res = await httpsPostJson(API_BASE + EP_CHECKIN, {
      headers: _headers(token, deviceId),
      body: {},
      timeoutMs,
    });
  } catch (e) {
    const hint = e.code ? ` [${e.code}]` : "";
    throw new Error("网络错误" + hint + ": " + e.message);
  }
  const j = _parse(res, EP_CHECKIN);
  if (j && typeof j === "object" && "data" in j && j.data) return j.data;
  return j ?? {};
}

/**
 * 领取今日签到积分（幂等：调用前先查 status，未签才 claim）。
 * @returns {Promise<object>} {checked_in, credits, streak_days, ...}
 */
export async function fetchCheckinClaim(token, deviceId, timeoutMs = FETCH_TIMEOUT_MS, machineId) {
  let res;
  try {
    res = await httpsPostJson(API_BASE + EP_CHECKIN_CLAIM, {
      headers: _headers(token, deviceId, {}, machineId),
      body: {},
      timeoutMs,
    });
  } catch (e) {
    const hint = e.code ? ` [${e.code}]` : "";
    throw new Error("网络错误" + hint + ": " + e.message);
  }
  if (res.status === 401 || res.status === 403) {
    throw new CredentialExpiredError(`凭证失效(HTTP ${res.status}) ${EP_CHECKIN_CLAIM}`, res.status);
  }
  // 与 _parse 不同：业务码(如 9074 高峰限流)不抛，返回给上层 claimWithRetry 重试
  let j;
  try {
    j = JSON.parse(res.body);
  } catch {
    throw new Error(`接口响应非 JSON(HTTP ${res.status}): ${EP_CHECKIN_CLAIM}`);
  }
  if (j && typeof j === "object" && "data" in j && j.data) return j.data;
  return j ?? {};
}
