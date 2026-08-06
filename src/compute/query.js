// src/compute/query.js - 查询编排层：批量查询全部账号（CLI 与 GUI 共用，原 lib/query.js）
// 职责：并发控制、单账号容错、lastStatus 持久化、汇总生成。
import { loadAccounts, saveAccounts } from "./store.js";
import { fetchCredits, CredentialExpiredError } from "./client.js";
import { summarize } from "./model.js";
import { CONCURRENCY, FETCH_TIMEOUT_MS } from "../config.js";

/**
 * 校验查询结果归属:接口返回的 Uin 必须与账号登记 Uin 一致。
 * 防串号(2026-08-06):cookie 混入多套会话时,去重可能保留他人会话,
 * 导致查到别的账号数据并被采样落库 —— 这里发现即抛错,不写历史。
 */
function assertOwner(account, data) {
  const realUin = data && data.Accounts && data.Accounts[0] && data.Accounts[0].Uin;
  if (account.uin && realUin && String(realUin) !== String(account.uin)) {
    throw new Error(
      `账号串号:接口返回 Uin=${realUin},登记 Uin=${account.uin}(cookie 属于其他账号,请重新登录后「添加当前账号」更新凭证)`
    );
  }
}

/**
 * 批量查询全部账号（带并发与容错，并持久化 lastStatus）。
 * @param {Array} [accounts] 账号池（缺省自动加载）
 * @returns {Promise<Array<{account, data, summary, error, expired}>>} 与入参顺序一致
 */
export async function fetchAllAccounts(accounts = loadAccounts()) {
  if (!accounts.length) return [];
  const results = new Array(accounts.length);
  let cursor = 0;
  const worker = async () => {
    while (cursor < accounts.length) {
      const i = cursor++;
      const a = accounts[i];
      try {
        const data = await fetchCredits(a.cookieHeader, FETCH_TIMEOUT_MS);
        assertOwner(a, data); // 串号即报错,不落库
        a.lastStatus = "ok";
        results[i] = { account: a, data, summary: summarize(data), error: null, expired: false };
      } catch (e) {
        const expired = e instanceof CredentialExpiredError;
        a.lastStatus = expired ? "expired" : "error";
        results[i] = { account: a, data: null, summary: null, error: e.message, expired };
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
 * 单账号实时查询（带容错与状态更新），CLI 与 GUI 共用。
 * @param {object} account 账号池中的账号对象
 * @returns {Promise<{account, data, summary, error, expired}>}
 */
export async function fetchOneAccount(account) {
  try {
    const data = await fetchCredits(account.cookieHeader, FETCH_TIMEOUT_MS);
    assertOwner(account, data); // 串号即报错,不落库
    account.lastStatus = "ok";
    return { account, data, summary: summarize(data), error: null, expired: false };
  } catch (e) {
    const expired = e instanceof CredentialExpiredError;
    account.lastStatus = expired ? "expired" : "error";
    return { account, data: null, summary: null, error: e.message, expired };
  }
}
