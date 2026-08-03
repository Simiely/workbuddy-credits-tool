// wb-credits.mjs - WorkBuddy 积分查询 CLI(多账号)
// 职责:命令分发 + 薄调用;查询编排在 lib/query.js,渲染在 lib/render.js
//
// 用法:
//   node wb-credits.mjs save-current [备注名]   # 把当前 Edge 登录的账号保存进账号池
//   node wb-credits.mjs accounts                # 列出账号池
//   node wb-credits.mjs rename <序号|id|Uin> <显示名>
//   node wb-credits.mjs del <序号|id|Uin>
//   node wb-credits.mjs all [--csv <路径>]      # 一键批量查询全部账号
//   node wb-credits.mjs [--account <序号|id|Uin>] [--all|--json|--csv <路径>]  # 单账号查询
//   (兼容别名) node wb-credits.mjs cookie        # = save-current
// 注:数据备份/恢复请用 GUI 的「☁️ 云同步」,命令行不再提供 export/import。
import fs from "node:fs";
import path from "node:path";
import { TOOLS_DIR } from "./lib/util.js";
import { loadAccounts, saveAccounts, displayName, findAccount } from "./lib/accounts.js";
import { fetchAllAccounts, fetchOneAccount } from "./lib/query.js";
import { saveCurrentFromEdge } from "./lib/account-ops.js";
import { renderSingleMarkdown, renderAllMarkdown, csvAll, csvSingle } from "./lib/render.js";

function fail(msg) {
  console.error("ERR:", msg);
  process.exit(1);
}

// ==================== 命令:save-current ====================
async function cmdSaveCurrent(remark) {
  const { account, isNew, sessionExpiresAt } = await saveCurrentFromEdge(remark);
  console.log(`OK: 账号[${displayName(account)}]${isNew ? "已保存" : "已更新"}(Uin: ${account.uin || "?"})`);
  if (sessionExpiresAt) {
    const days = Math.max(0, Math.floor((new Date(sessionExpiresAt).getTime() - Date.now()) / 86400000));
    console.log(`凭证有效期约 ${days} 天(至 ${new Date(sessionExpiresAt).toLocaleString("zh-CN")})`);
  }
  console.log(`账号池现有 ${loadAccounts().length} 个账号,运行 "wb-credits.bat all" 一键查询全部`);
}

// ==================== 命令:accounts / rename / del ====================
function cmdListAccounts() {
  const accounts = loadAccounts();
  if (!accounts.length) return console.log("账号池为空,先运行: wb-credits.bat save-current");
  console.log(`# 账号池(${accounts.length} 个)`);
  console.log("");
  console.log("| # | 显示名称 | 手机号/原名称 | Uin | 状态 | 凭证到期 |");
  console.log("|---|---|---|---|---|---|");
  accounts.forEach((a, i) => {
    const st = a.lastStatus === "ok" ? "✅ 有效" : a.lastStatus === "expired" ? "⚠️ 凭证过期" : "❌ 错误";
    const exp = a.sessionExpiresAt ? new Date(a.sessionExpiresAt).toLocaleDateString("zh-CN") : "?";
    console.log(`| ${i + 1} | ${displayName(a)} | ${a.name || "?"} | ${a.uin || "?"} | ${st} | ${exp} |`);
  });
}

function cmdRename(key, newName) {
  const accounts = loadAccounts();
  const target = findAccount(accounts, key);
  if (!target) return fail("未找到账号: " + key);
  const old = displayName(target);
  target.displayName = String(newName || "").trim();
  saveAccounts(accounts);
  console.log(`已设置显示名称:[${old}] -> [${target.displayName || target.name}]`);
}

function cmdDelete(key) {
  const accounts = loadAccounts();
  const target = findAccount(accounts, key);
  if (!target) return fail("未找到账号: " + key);
  accounts.splice(accounts.indexOf(target), 1);
  saveAccounts(accounts);
  console.log(`已删除账号[${displayName(target)}]`);
}

// ==================== 命令:all(批量查询) ====================
async function cmdAll(args) {
  const accounts = loadAccounts();
  if (!accounts.length) return fail("账号池为空,先运行: wb-credits.bat save-current");
  const results = await fetchAllAccounts(accounts);
  if (args.includes("--csv")) {
    const p = args[args.indexOf("--csv") + 1] || path.join(TOOLS_DIR, "wb-accounts-all.csv");
    fs.writeFileSync(p, csvAll(results), "utf8");
    console.log("CSV 已保存:", p);
    return;
  }
  renderAllMarkdown(results);
}

// ==================== 单账号查询 ====================
async function cmdQuerySingle(args) {
  const accounts = loadAccounts();
  if (!accounts.length) fail("账号池为空,先运行: wb-credits.bat save-current");
  let target = accounts[0];
  const accArg = args.find((a) => a.startsWith("--account="));
  if (accArg) {
    const key = accArg.split("=")[1];
    target = findAccount(accounts, key);
    if (!target) fail("未找到账号: " + key);
  }
  if (target.sessionExpiresAt && new Date(target.sessionExpiresAt).getTime() - Date.now() < 86400000) {
    console.warn(`[提醒] 账号[${displayName(target)}]凭证将于 ${target.sessionExpiresAt} 过期,建议: wb-credits.bat save-current`);
  }
  const r = await fetchOneAccount(target);
  if (!r.data) return fail(r.error || "查询失败");
  const D = r.data;
  saveAccounts(loadAccounts());
  if (args.includes("--json")) return console.log(JSON.stringify(D, null, 1));
  if (args.includes("--csv")) {
    const p = args[args.indexOf("--csv") + 1] || path.join(TOOLS_DIR, "wb-credits.csv");
    fs.writeFileSync(p, csvSingle(D), "utf8");
    return console.log("CSV 已保存:", p);
  }
  renderSingleMarkdown(D, args.includes("--all"), target);
}

// ==================== 入口:命令分发 ====================
async function main() {
  const args = process.argv.slice(2);
  const cmd = args[0] || "query";
  try {
    if (cmd === "save-current" || cmd === "cookie") return await cmdSaveCurrent(args[1]);
    if (cmd === "accounts") return cmdListAccounts();
    if (cmd === "rename") return cmdRename(args[1], args[2]);
    if (cmd === "del") return cmdDelete(args[1]);
    if (cmd === "all" || cmd === "batch") return await cmdAll(args);
    return await cmdQuerySingle(args);
  } catch (e) {
    fail(e.message);
  }
}
main();
