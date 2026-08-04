// src/compute/query.js - 查询编排层：批量查询全部账号（CLI 与 GUI 共用，原 lib/query.js）
// 职责：并发控制、单账号容错、lastStatus 持久化、汇总生成。
import { loadAccounts, saveAccounts } from "./store.js";
import { fetchCredits, CredentialExpiredError } from "./client.js";
import { summarize } from "./model.js";
import { CONCURRENCY, FETCH_TIMEOUT_MS } from "../config.js";

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
    account.lastStatus = "ok";
    return { account, data, summary: summarize(data), error: null, expired: false };
  } catch (e) {
    const expired = e instanceof CredentialExpiredError;
    account.lastStatus = expired ? "expired" : "error";
    return { account, data: null, summary: null, error: e.message, expired };
  }
}
