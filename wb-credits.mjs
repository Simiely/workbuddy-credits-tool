// wb-credits.mjs - WorkBuddy 积分查询 CLI（多账号）· 薄命令分发层
// 业务全在 src/：查询编排 src/compute/query、账号池 src/compute/store、
// 采集 src/collect、渲染 src/present/render。
//
// 用法:
//   node wb-credits.mjs import <wb-accounts.json>  # 从 Edge 插件导出的文件导入账号池(替代旧 save-current)
//   node wb-credits.mjs accounts                # 列出账号池
//   node wb-credits.mjs rename <序号|id|Uin> <显示名>
//   node wb-credits.mjs del <序号|id|Uin>
//   node wb-credits.mjs all [--csv <路径>]      # 一键批量查询全部账号
//   node wb-credits.mjs report                  # 派生视图:当前剩余/今日已用/累计已用
//   node wb-credits.mjs [--account <序号|id|Uin>] [--all|--json|--csv <路径>]  # 单账号查询
// 注:账号采集统一走 Edge 插件(导出 wb-accounts.json)→ 本命令 import;数据备份/恢复用 GUI 的「☁️ 云同步」。
import fs from "node:fs";
import path from "node:path";
import { TOOLS_DIR } from "./src/config.js";
import { loadAccounts, saveAccounts, displayName, findAccount, mergeAccountsSmart } from "./src/compute/store.js";
import { fetchAllAccounts, fetchOneAccount } from "./src/compute/query.js";
import { deriveAll } from "./src/compute/derive.js";
import { renderSingleMarkdown, renderAllMarkdown, csvAll, csvSingle } from "./src/present/render.js";

function fail(msg) {
  console.error("ERR:", msg);
  process.exit(1);
}
const fmt = (n) => Math.round((n || 0) * 100) / 100; // 四舍五入,保证 CLI/GUI 口径一致

// ==================== 命令:import(从 Edge 插件导出的 wb-accounts.json 导入) ====================
// 采集统一走 Edge 插件(chrome.cookies 官方 API 读登录态)→ 导出文件 → 本命令 smart 合并进账号池
async function cmdImport(file) {
  if (!file) return fail("用法: wb-credits.bat import <wb-accounts.json>");
  if (!fs.existsSync(file)) return fail("文件不存在: " + file);
  let data;
  try { data = JSON.parse(fs.readFileSync(file, "utf8")); }
  catch { return fail("文件不是合法 JSON: " + file); }
  const incoming = Array.isArray(data.accounts) ? data.accounts : [];
  if (!incoming.length) return fail("文件中无账号数据(accounts 为空)");
  const local = loadAccounts();
  const tombList = Array.isArray(data.tombstones) ? data.tombstones : [];
  const tombMap = new Map(
    tombList.filter((t) => t && t.uin).map((t) => [String(t.uin), t.deletedAt || new Date().toISOString()])
  );
  const merged = mergeAccountsSmart(local, incoming, tombMap);
  saveAccounts(local);
  console.log(`OK: 已导入账号,账号池现有 ${local.length} 个(新增 ${merged.added || 0} / 更新 ${merged.updated || 0})`);
}

// ==================== 命令:accounts / rename / del ====================
function cmdListAccounts() {
  const accounts = loadAccounts();
  if (!accounts.length) return console.log("账号池为空,先运行: wb-credits.bat import <文件>");
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
  if (!accounts.length) return fail("账号池为空,先运行: wb-credits.bat import <文件>");
  const results = await fetchAllAccounts(accounts);
  if (args.includes("--csv")) {
    const p = args[args.indexOf("--csv") + 1] || path.join(TOOLS_DIR, "wb-accounts-all.csv");
    fs.writeFileSync(p, csvAll(results), "utf8");
    console.log("CSV 已保存:", p);
    return;
  }
  renderAllMarkdown(results);
}

// ==================== 命令:report(派生视图,复用引擎) ====================
// 复用 src/compute/derive.js 的 deriveAll,打印当前剩余/今日已用/累计已用等派生指标
// 注: 耗尽预测(dailyRate/daysToEmpty)已于 v1.4.15 主动下线(预测不准),故不在此展示。
function cmdReport() {
  const accounts = loadAccounts();
  if (!accounts.length) return fail("账号池为空,先运行: wb-credits.bat import <文件>");
  const per = deriveAll(accounts);
  console.log(`# 额度派生视图(${new Date().toLocaleString("zh-CN")}) · 数据源:readings 时序`);
  console.log("");
  console.log("| # | 账号 | 当前剩余 | 今日已用 | 累计已用 | 数据点 |");
  console.log("|---|---|---|---|---|---|");
  per.forEach((d, i) => {
    console.log(
      `| ${i + 1} | ${displayName(d)} | ${fmt(d.currentRemain)} | ${fmt(d.todayUsed)} | ${fmt(d.consumed)} | ${d.points} |`
    );
  });
  console.log("");
  console.log("提示: 派生指标基于历史快照,先运行 wb-credits.bat all 产生快照,再运行 report 查看趋势");
}

// ==================== 单账号查询 ====================
async function cmdQuerySingle(args) {
  const accounts = loadAccounts();
  if (!accounts.length) fail("账号池为空,先运行: wb-credits.bat import <文件>");
  let target = accounts[0];
  const accArg = args.find((a) => a.startsWith("--account="));
  if (accArg) {
    const key = accArg.split("=")[1];
    target = findAccount(accounts, key);
    if (!target) fail("未找到账号: " + key);
  }
  if (target.sessionExpiresAt && new Date(target.sessionExpiresAt).getTime() - Date.now() < 86400000) {
    console.warn(`[提醒] 账号[${displayName(target)}]凭证将于 ${target.sessionExpiresAt} 过期,建议: wb-credits.bat import <文件>`);
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
    if (cmd === "save-current" || cmd === "cookie")
      return fail("save-current/cookie 已弃用(v1.4.65):账号采集统一走 Edge 插件导出 wb-accounts.json,再运行 wb-credits.bat import <文件>");
    if (cmd === "import") return await cmdImport(args[1]);
    if (cmd === "accounts") return cmdListAccounts();
    if (cmd === "rename") return cmdRename(args[1], args[2]);
    if (cmd === "del") return cmdDelete(args[1]);
    if (cmd === "all" || cmd === "batch") return await cmdAll(args);
    if (cmd === "report") return cmdReport();
    return await cmdQuerySingle(args);
  } catch (e) {
    fail(e.message);
  }
}
main();
