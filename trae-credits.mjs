// trae-credits.mjs - TRAE Work 积分查询 CLI（多账号）· 薄命令分发层
// 业务全在 src/：查询编排 src/compute/query、账号池 src/compute/store、
// 解密/发现 src/compute/trae-decrypt + discover、渲染 src/present/render。
//
// 用法:
//   node trae-credits.mjs scan                     # 扫描本机 TRAE 登录态 + MultiSwitch 槽 → 建立账号池
//   node trae-credits.mjs import <trae-accounts.json>  # 从 WebDAV 镜像/备份导入账号池
//   node trae-credits.mjs accounts                # 列出账号池
//   node trae-credits.mjs rename <序号|id|Uin> <显示名>
//   node trae-credits.mjs del <序号|id|Uin>
//   node trae-credits.mjs all [--csv <路径>]      # 一键批量查询全部账号
//   node trae-credits.mjs [--account <序号|id|Uin>] [--json|--csv <路径>]  # 单账号查询
// 注:账号采集=TRAE 桌面端登录态(storage.json 加密),由 scan 自动发现本机登录与槽备份。
import fs from "node:fs";
import path from "node:path";
import { TOOLS_DIR } from "./src/config.js";
import {
  loadAccounts, saveAccounts, displayName, findAccount,
  mergeAccountsSmart, addOrUpdateAccount, mergeDiscovered,
} from "./src/compute/store.js";
import { fetchAllAccounts, fetchOneAccount, fetchTraeCheckin, fetchTraeCheckinStatus } from "./src/compute/query.js";
import { accountFromMultiSwitchExport } from "./src/compute/discover.js";
import { deriveAll } from "./src/compute/derive.js";
import { isWorkBuddy, readWbInfo, fetchWbCheckinStatus, fetchWbDailyCheckin } from "./src/compute/wb.js";
import { renderSingleMarkdown, renderAllMarkdown, csvAll, csvSingle } from "./src/present/render.js";

function fail(msg) {
  console.error("ERR:", msg);
  process.exit(1);
}
const fmt = (n) => Math.round((n || 0) * 100) / 100; // 四舍五入,保证 CLI/GUI 口径一致

// ==================== 命令:scan(扫描本机 TRAE 登录态 + 槽 → 建立账号池) ====================
// TRAE 无网页 cookie 采集;登录态在本地 storage.json(含 MultiSwitch 槽备份)。
// 直接复用 store.mergeDiscovered(与 GUI 读取/云同步同一套「发现即入库」逻辑,单一真相,不再各写一份)。
async function cmdScan() {
  const local = loadAccounts();
  const { added, updated, skipped } = await mergeDiscovered(local);
  if (!added && !updated && !skipped) {
    return fail("未扫描到任何有效登录态(TRAE: 请先登录或配置 TRAE_SLOT_ROOT;WorkBuddy: 请先登录或配置 WB_SLOT_ROOT)");
  }
  saveAccounts(local);
  console.log(`OK: 账号池现有 ${local.length} 个(新增 ${added} / 更新 ${updated} / 未变 ${skipped})`);
  console.log("");
  local.forEach((a, i) => console.log(`  ${i + 1}) ${displayName(a)}  [${a.name || a.appKey}]  ${isWorkBuddy(a) ? "wb uid=" + a.uin : "uid=" + a.uin}`));
}

// ==================== 命令:import(导入账号池:账号池快照 或 MultiSwitch 导出凭证) ====================
async function cmdImport(file) {
  if (!file) return fail("用法: trae-credits.bat import <trae-accounts.json 或 MultiSwitch导出凭证.json>");
  if (!fs.existsSync(file)) return fail("文件不存在: " + file);
  let data;
  try { data = JSON.parse(fs.readFileSync(file, "utf8")); }
  catch { return fail("文件不是合法 JSON: " + file); }
  // 兼容 MultiSwitch「🔑导出凭证」单账号 json(token) → 转成账号记录
  const msRec = accountFromMultiSwitchExport(data);
  const incoming = msRec ? [msRec] : Array.isArray(data.accounts) ? data.accounts : [];
  if (!incoming.length)
    return fail("文件中无账号数据(既非账号池快照 accounts[], 也非 MultiSwitch 导出凭证)");
  const local = loadAccounts();
  const tombList = Array.isArray(data.tombstones) ? data.tombstones : [];
  const tombMap = new Map(
    tombList.filter((t) => t && t.uin).map((t) => [String(t.uin), t.deletedAt || new Date().toISOString()])
  );
  const merged = mergeAccountsSmart(local, incoming, tombMap);
  saveAccounts(local);
  const kind = msRec ? `MultiSwitch 导出凭证「${msRec.displayName || msRec.name}」` : "账号池快照";
  console.log(`OK: 已导入${kind},账号池现有 ${local.length} 个(新增 ${merged.added || 0} / 更新 ${merged.updated || 0})`);
}

// ==================== 命令:accounts / rename / del ====================
function cmdListAccounts() {
  const accounts = loadAccounts();
  if (!accounts.length) return console.log("账号池为空,先运行: trae-credits.bat scan");
  console.log(`# 账号池(${accounts.length} 个)`);
  console.log("");
  console.log("| # | 显示名称 | 用户名 | Uin | 状态 | 凭证到期 | 登录态来源 |");
  console.log("|---|---|---|---|---|---|---|");
  accounts.forEach((a, i) => {
    const st = a.lastStatus === "ok" ? "✅ 有效" : a.lastStatus === "expired" ? "⚠️ 凭证过期" : "❌ 错误";
    const exp = a.sessionExpiresAt ? new Date(a.sessionExpiresAt).toLocaleDateString("zh-CN") : "?";
    const src = a.source === "slot" ? "槽备份" : a.source === "local" ? "本机登录" : (a.source || "?");
    console.log(`| ${i + 1} | ${displayName(a)} | ${a.name || "?"} | ${a.uin || "?"} | ${st} | ${exp} | ${src} |`);
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
  if (!accounts.length) return fail("账号池为空,先运行: trae-credits.bat scan");
  const results = await fetchAllAccounts(accounts);
  if (args.includes("--csv")) {
    const p = args[args.indexOf("--csv") + 1] || path.join(TOOLS_DIR, "trae-accounts-all.csv");
    fs.writeFileSync(p, csvAll(results), "utf8");
    console.log("CSV 已保存:", p);
    return;
  }
  renderAllMarkdown(results);
}

// ==================== 命令:report(派生视图,复用引擎) ====================
function cmdReport() {
  const accounts = loadAccounts();
  if (!accounts.length) return fail("账号池为空,先运行: trae-credits.bat scan");
  const per = deriveAll(accounts);
  console.log(`# TRAE 积分派生视图(${new Date().toLocaleString("zh-CN")}) · 数据源:readings 时序`);
  console.log("");
  console.log("| # | 账号 | 当前剩余 | 今日已用 | 累计已用 | 数据点 |");
  console.log("|---|---|---|---|---|---|");
  per.forEach((d, i) => {
    console.log(
      `| ${i + 1} | ${displayName(d)} | ${fmt(d.currentRemain)} | ${fmt(d.todayUsed)} | ${fmt(d.consumed)} | ${d.points} |`
    );
  });
  console.log("");
  console.log("提示: 派生指标基于历史快照,先运行 trae-credits.bat all 产生快照,再运行 report 查看趋势");
}

// ==================== 单账号查询 ====================
async function cmdQuerySingle(args) {
  const accounts = loadAccounts();
  if (!accounts.length) fail("账号池为空,先运行: trae-credits.bat scan");
  let target = accounts[0];
  const accArg = args.find((a) => a.startsWith("--account="));
  if (accArg) {
    const key = accArg.split("=")[1];
    target = findAccount(accounts, key);
    if (!target) fail("未找到账号: " + key);
  }
  const r = await fetchOneAccount(target);
  if (!r.data) return fail(r.error || "查询失败");
  saveAccounts(loadAccounts());
  if (args.includes("--json")) return console.log(JSON.stringify(r.data, null, 1));
  if (args.includes("--csv")) {
    const p = args[args.indexOf("--csv") + 1] || path.join(TOOLS_DIR, "trae-credits.csv");
    fs.writeFileSync(p, csvSingle(r.data), "utf8");
    return console.log("CSV 已保存:", p);
  }
  renderSingleMarkdown(r.data, r.checkin, args.includes("--all"), target);
}

// ==================== 命令:checkin(每日签到, TRAE + WorkBuddy 双源, 幂等) ====================
// TRAE 源: storage.json 解密 token → status(只读) → 未签则 claim(领取)。
// WorkBuddy 源: .info Bearer token → daily-checkin(已签返回 code=10001 按成功)。
// 两者均幂等: 已签到跳过不重复领取。
//  --dry-run / --check : 只查状态,不实际领取
//  --account=<序号|id|uid> : 只签到指定账号
async function cmdCheckin(args) {
  const local = loadAccounts();
  if (!local.length) return fail("账号池为空,先运行: trae-credits.bat scan");
  const dryRun = args.includes("--dry-run") || args.includes("--check");
  const accArg = args.find((a) => a.startsWith("--account="));
  let targets = local;
  if (accArg) {
    const t = findAccount(local, accArg.split("=")[1]);
    if (!t) return fail("未找到账号: " + accArg.split("=")[1]);
    targets = [t];
  }
  console.log(`# 每日签到(TRAE + WorkBuddy) · ${dryRun ? "仅查状态" : "领取"} · ${new Date().toLocaleString("zh-CN")}`);
  console.log("");
  console.log("| # | 账号 | 来源 | 域名 | 结果 |");
  console.log("|---|---|---|---|---|");
  let added = 0, already = 0, failed = 0, i = 0;
  for (const a of targets) {
    i++;
    if (isWorkBuddy(a)) {
      const rec = readWbInfo(a.cookieHeader);
      const domain = rec.domain;
      const name = a.name || rec.nickname || "?";
      if (dryRun) {
        const st = await fetchWbCheckinStatus(rec);
        const done = !!(st && (st.today_checked_in || st.checked_in));
        if (done) already++;
        else added++;
        console.log(`| ${i} | ${name} | WorkBuddy | ${domain} | ${done ? "今日已签" : "待签到"} |`);
        continue;
      }
      try {
        const r = await fetchWbDailyCheckin(rec);
        if (r.already) { already++; console.log(`| ${i} | ${name} | WorkBuddy | ${domain} | 今日已签(跳过) |`); }
        else if (r.ok) { added++; console.log(`| ${i} | ${name} | WorkBuddy | ${domain} | ✅ 领到 ${r.credit ?? "?"} 积分,连签 ${r.streak ?? "?"} 天${r.msg ? " · " + r.msg : ""} |`); }
        else { failed++; console.log(`| ${i} | ${name} | WorkBuddy | ${domain} | ❌ ${r.msg || "失败"} |`); }
      } catch (e) { failed++; console.log(`| ${i} | ${name} | WorkBuddy | ${domain} | ❌ ${e.message} |`); }
      continue;
    }
    // TRAE 来源
    const name = a.displayName || a.name || "?";
    const domain = "api.trae.cn";
    if (dryRun) {
      const r = await fetchTraeCheckinStatus(a);
      if (!r.ok) { failed++; console.log(`| ${i} | ${name} | TRAE | ${domain} | ❌ ${r.msg || "失败"} |`); }
      else { if (r.done) already++; else added++; console.log(`| ${i} | ${name} | TRAE | ${domain} | ${r.done ? "今日已签" : "待签到"} |`); }
      continue;
    }
    const r = await fetchTraeCheckin(a);
    if (r.already) { already++; console.log(`| ${i} | ${name} | TRAE | ${domain} | 今日已签(跳过) |`); }
    else if (r.ok) { added++; console.log(`| ${i} | ${name} | TRAE | ${domain} | ✅ 领到 ${r.credit ?? "?"} 积分,连签 ${r.streak ?? "?"} 天${r.msg ? " · " + r.msg : ""} |`); }
    else { failed++; console.log(`| ${i} | ${name} | TRAE | ${domain} | ❌ ${r.msg || "失败"} |`); }
  }
  console.log("");
  console.log(`汇总: 领取 ${added} / 已签跳过 ${already} / 失败 ${failed}`);
  if (dryRun) console.log("提示: 去掉 --dry-run 即实际领取签到积分(幂等,已签安全)。");
}

// ==================== 入口:命令分发 ====================
async function main() {
  const args = process.argv.slice(2);
  const cmd = args[0] || "query";
  try {
    if (cmd === "scan" || cmd === "s") return await cmdScan();
    if (cmd === "import") return await cmdImport(args[1]);
    if (cmd === "accounts") return cmdListAccounts();
    if (cmd === "rename") return cmdRename(args[1], args[2]);
    if (cmd === "del") return cmdDelete(args[1]);
    if (cmd === "all" || cmd === "batch") return await cmdAll(args);
    if (cmd === "report") return cmdReport();
    if (cmd === "checkin") return await cmdCheckin(args);
    return await cmdQuerySingle(args);
  } catch (e) {
    fail(e.message);
  }
}
main();
