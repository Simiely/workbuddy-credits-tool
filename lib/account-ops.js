// lib/account-ops.js - 账号操作层:添加当前账号(CLI 与 GUI 共用)
// 职责:从 Edge 读取当前登录账号 → 校验 → 存入账号池(去重更新)。
import { loadAccounts, saveAccounts, addOrUpdateAccount, newAccountId } from "./accounts.js";
import { getEdgeCookies, phoneFromPage } from "./cookies.js";
import { probeAccount } from "./workbuddy.js";

/**
 * 将 Edge 当前登录的 WorkBuddy 账号保存进账号池(已存在则更新)。
 * @param {string} [remark] 备注名(优先于页面提取的手机号)
 * @returns {Promise<{account, isNew, sessionExpiresAt}>}
 */
export async function saveCurrentFromEdge(remark) {
  const { cookieHeader, sessionExpiresAt } = await getEdgeCookies();
  const { uin } = await probeAccount(cookieHeader); // 校验有效性并探测 Uin
  const phone = (remark || "").trim() || (await phoneFromPage());
  const accounts = loadAccounts();
  const existing = accounts.find((a) => a.uin && uin && a.uin === uin);
  const name = phone || (existing ? existing.name : `账号${accounts.length + 1}`);
  const rec = {
    id: existing ? existing.id : newAccountId(),
    name, uin, cookieHeader, sessionExpiresAt,
    addedAt: existing ? existing.addedAt : new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    lastStatus: "ok",
  };
  const { account, isNew } = addOrUpdateAccount(accounts, rec);
  saveAccounts(accounts);
  return { account, isNew, sessionExpiresAt };
}
