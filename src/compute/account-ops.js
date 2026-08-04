// src/compute/account-ops.js - 添加账号（采集 → 校验 → 入池去重更新），原 lib/account-ops.js
// 与具体采集方案解耦：只调用 collect 层统一的 captureCurrentAccount，
// 桌面走 Edge、容器走 WebDAV 的差异全在 collect 层内部。
import { captureCurrentAccount } from "../collect/index.js";
import { probeAccount } from "./client.js";
import { loadAccounts, saveAccounts, addOrUpdateAccount, newAccountId } from "./store.js";

/**
 * 将当前登录的 WorkBuddy 账号保存进账号池（已存在则更新）。
 * @param {string} [remark] 备注名（优先于页面提取的手机号）
 * @returns {Promise<{account, isNew, sessionExpiresAt}>}
 */
export async function saveCurrentFromEdge(remark) {
  const { cookieHeader, sessionExpiresAt, name } = await captureCurrentAccount(remark);
  const { uin } = await probeAccount(cookieHeader); // 校验有效性并探测 Uin
  const accounts = loadAccounts();
  const existing = accounts.find((a) => a.uin && uin && a.uin === uin);
  const recName = name || (existing ? existing.name : `账号${accounts.length + 1}`);
  const rec = {
    id: existing ? existing.id : newAccountId(),
    name: recName,
    uin,
    cookieHeader,
    sessionExpiresAt,
    addedAt: existing ? existing.addedAt : new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    lastStatus: "ok",
  };
  const { account, isNew } = addOrUpdateAccount(accounts, rec);
  saveAccounts(accounts);
  return { account, isNew, sessionExpiresAt };
}
