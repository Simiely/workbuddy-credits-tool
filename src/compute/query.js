// src/compute/query.js - 查询编排层：批量查询全部账号（CLI 与 GUI 共用，TRAE Work 版）
// 职责：并发控制、单账号容错、lastStatus 持久化、汇总生成。
// TRAE 凭证=本地 storage.json 路径（账号.cookieHeader 字段存该路径），查询前现解密取 token，
// 不落盘明文 token。同时采集「积分权益(entitlement)」与「今日签到(checkin)」。
import fs from "node:fs";
import path from "node:path";
import { loadAccounts, saveAccounts, reconcileFromDisk } from "./store.js";
import { resolveSlotPath } from "./paths.js";
import {
  fetchEntitlement,
  fetchCheckin,
  fetchCheckinClaim,
  CredentialExpiredError,
} from "./client.js";
import { readAccountAuth } from "./trae-decrypt.js";
import { summarize } from "./model.js";
import { isWorkBuddy, readWbInfo, fetchWbDailyCheckin, fetchWbUsage, summarizeWbResources } from "./wb.js";
import { CONCURRENCY, FETCH_TIMEOUT_MS } from "../config.js";
import { autoPullSlotsIfMissing } from "./webdav.js";

/**
 * WorkBuddy 账号采集：积分额度(get-user-resource) + 今日签到。幂等。
 * 返回供渲染的统一结构：{ account, data, summary, checkin, error, expired }
 * data=积分资源包原始对象；summary=align TRAE summarize 口径；checkin=今日签到。
 */
async function fetchWbAccount(account) {
  try {
    const candidates = [resolveSlotPath(account), account.cookieHeader].filter(Boolean);
    let usePath = candidates.find((p) => p[0] === "{" || p[0] === "[" || fs.existsSync(p)) || candidates[0];
    if (!usePath) throw new Error("账号未绑定凭证(cookieHeader 为空)");
    usePath = usePath[0] === "/" || usePath[0] === "\\" || /^[A-Za-z]:/.test(usePath) ? path.normalize(usePath) : usePath;
    if (usePath[0] !== "{" && usePath[0] !== "[" && !fs.existsSync(usePath)) {
      throw new Error(
        `本机未找到该账号登录态槽: ${usePath}\n` +
          `请先「云同步」把登录态拉到本工具指定目录（可用环境变量 WB_SLOT_ROOT / TRAE_SLOT_ROOT 指向部署机专有目录）`
      );
    }
    const rec = readWbInfo(usePath);
    account.lastStatus = "ok";
    // 积分额度（非致命：失败仍返回签到，避免单账号整体失败）
    let data = null, summary = null, usageError = null;
    try {
      const rd = await fetchWbUsage(rec, FETCH_TIMEOUT_MS);
      data = rd;
      summary = summarizeWbResources(rd);
    } catch (e) {
      usageError = e.message;
      if (e instanceof CredentialExpiredError) {
        return { account, data: null, summary: null, checkin: null, error: e.message, expired: true };
      }
    }
    let checkin = null;
    try {
      checkin = await fetchWbDailyCheckin(rec, FETCH_TIMEOUT_MS);
    } catch {
      checkin = null; // 签到失败不阻断（同 TRAE 分支）
    }
    return {
      account, data, summary, checkin,
      error: usageError ? `积分查询失败: ${usageError}` : null,
      expired: false,
    };
  } catch (e) {
    const expired = e instanceof CredentialExpiredError;
    account.lastStatus = expired ? "expired" : "error";
    return {
      account, data: null, summary: null, checkin: null,
      error: e.message, expired,
    };
  }
}

/**
 * 从账号登记的解密来源取出实时认证（token + deviceId）。
 * 账号.cookieHeader 支持两种语义：
 *   - TRAE 版旧语义 = storage.json 绝对路径（现场解密，token 不落盘明文）；
 *   - v1.5.x 内联凭证 = MultiSwitch「🔑导出凭证」json 封装（token 直接可用，不依赖本机文件）。
 * @returns {{token:string, deviceId:string|null}}
 */
export function resolveAccountAuth(account) {
  const r = readAccountAuth(account);
  const token = r.auth.token;
  if (!token) throw new Error("解密无 token（未登录或登录态失效）");
  return { token, deviceId: r.deviceId, machineId: r.machineId, userId: r.auth.userId, accountName: r.auth.account?.username };
}

/**
 * 领取签到并处理 9074（参与用户太多=高峰限流）：按退避重试。
 * 参考论坛实测：9074 是大量自动签到脚本竞争导致的高峰限流，非接口失效；低峰/重试可成功。
 */
async function claimWithRetry(token, deviceId, machineId, timeoutMs) {
  const attempts = 6;                 // 最多 6 次
  const baseDelay = 12000;            // 起始等待 12s
  let j = null;
  for (let a = 1; a <= attempts; a++) {
    j = await fetchCheckinClaim(token, deviceId, timeoutMs, machineId);
    const code = j && typeof j === "object" ? j.code : null;
    if (code !== 9074) return j;
    if (a < attempts) {
      const jitter = Math.floor(Math.random() * 8000);
      await new Promise((r) => setTimeout(r, baseDelay + jitter));
    }
  }
  return j;
}

/**
 * 校验查询结果归属：解密出的 userId 必须与账号登记 uin 一致（防串号/防错位落库）。
 */
function assertOwner(account, userId) {
  if (account.uin && userId && String(userId) !== String(account.uin)) {
    throw new Error(
      `账号串号:本 storage 登录 userId=${userId},登记 uin=${account.uin}(登录态属于其他账号,请重新采集更新)`
    );
  }
}

/**
 * 批量查询全部账号（带并发与容错，并持久化 lastStatus）。
 * @param {Array} [accounts] 账号池（缺省自动加载）
 * @returns {Promise<Array<{account, data, summary, checkin, error, expired}>>} 与入参顺序一致
 */
export async function fetchAllAccounts(accounts) {
  // 读取前先对账:把本机登录态槽自动入库,新增账号即时可读(与 GUI 列表/云同步/scan 同一逻辑,单一真相)
  if (!accounts) accounts = await reconcileFromDisk();
  // 部署机兜底：wb-sync.json 已配 url 且本地缺槽时先自动从 WebDAV 拉取（失败不影响查询）
  try {
    await autoPullSlotsIfMissing();
  } catch {}
  if (!accounts.length) return [];
  const results = new Array(accounts.length);
  let cursor = 0;
  const worker = async () => {
    while (cursor < accounts.length) {
      const i = cursor++;
      const a = accounts[i];
      if (isWorkBuddy(a)) {
        results[i] = await fetchWbAccount(a);
        continue;
      }
      try {
        const { token, deviceId, userId } = resolveAccountAuth(a);
        assertOwner(a, userId);
        const data = await fetchEntitlement(token, deviceId, FETCH_TIMEOUT_MS);
        let checkin = null;
        try {
          checkin = await fetchCheckin(token, deviceId, FETCH_TIMEOUT_MS);
        } catch {
          checkin = null; // 签到失败不阻断主查询
        }
        a.lastStatus = "ok";
        results[i] = {
          account: a, data, summary: summarize(data), checkin,
          error: null, expired: false,
        };
      } catch (e) {
        const expired = e instanceof CredentialExpiredError;
        a.lastStatus = expired ? "expired" : "error";
        results[i] = { account: a, data: null, summary: null, checkin: null, error: e.message, expired };
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, accounts.length) }, worker)
  );
  saveAccounts(accounts); // 持久化状态
  return results;
}

/**
 * 单账号实时查询（带容错与状态更新）。
 * @param {object} account 账号池中的账号对象
 * @returns {Promise<{account, data, summary, checkin, error, expired}>}
 */
export async function fetchOneAccount(account) {
  try {
    await autoPullSlotsIfMissing();
  } catch {}
  if (isWorkBuddy(account)) return fetchWbAccount(account);
  try {
    const { token, deviceId, userId } = resolveAccountAuth(account);
    assertOwner(account, userId);
    const data = await fetchEntitlement(token, deviceId, FETCH_TIMEOUT_MS);
    let checkin = null;
    try {
      checkin = await fetchCheckin(token, deviceId, FETCH_TIMEOUT_MS);
    } catch {
      checkin = null;
    }
    account.lastStatus = "ok";
    return { account, data, summary: summarize(data), checkin, error: null, expired: false };
  } catch (e) {
    const expired = e instanceof CredentialExpiredError;
    account.lastStatus = expired ? "expired" : "error";
    return { account, data: null, summary: null, checkin: null, error: e.message, expired };
  }
}

/**
 * TRAE 账号今日签到状态查询（只读，不改状态）。
 * @returns {{ok:boolean, done:boolean, streak:number|null, msg?:string}}
 */
export async function fetchTraeCheckinStatus(account) {
  try {
    const { token, deviceId, userId } = resolveAccountAuth(account);
    assertOwner(account, userId);
    const st = await fetchCheckin(token, deviceId, FETCH_TIMEOUT_MS);
    const done = !!(st && (st.checked_in || st.today_checked_in));
    return { ok: true, done, streak: st && typeof st.streak_days === "number" ? st.streak_days : null };
  } catch (e) {
    return { ok: false, done: false, streak: null, msg: e.message };
  }
}

/**
 * TRAE 账号每日签到（幂等）：先查 status，未签才 claim。
 * @returns {{ok:boolean, already:boolean, credit:number|null, streak:number|null, msg:string}}
 */
export async function fetchTraeCheckin(account) {
  try {
    const { token, deviceId, machineId, userId } = resolveAccountAuth(account);
    assertOwner(account, userId);
    const st = await fetchCheckin(token, deviceId, FETCH_TIMEOUT_MS);
    if (st && (st.checked_in || st.today_checked_in)) {
      return {
        ok: true, already: true, credit: null,
        streak: st && typeof st.streak_days === "number" ? st.streak_days : null,
        msg: "",
      };
    }
    const d = await claimWithRetry(token, deviceId, machineId, FETCH_TIMEOUT_MS);
    const code = d && typeof d === "object" ? d.code : null;
    if (code === 9074) {
      return { ok: false, already: false, credit: null, streak: null, msg: "签到高峰限流(9074)，请低峰期重试" };
    }
    const credit =
      typeof d.credits === "number"
        ? d.credits
        : typeof d.credit === "number"
          ? d.credit
          : typeof d.points === "number"
            ? d.points
            : null;
    const streak = typeof d.streak_days === "number" ? d.streak_days : null;
    const msg = String(d.message || d.msg || "");
    return { ok: true, already: false, credit, streak, msg: msg.trim() };
  } catch (e) {
    return {
      ok: false, already: false, credit: null, streak: null,
      msg: e.message, expired: e instanceof CredentialExpiredError,
    };
  }
}
