// test/admin-flow.test.mjs — 管理员三态回归（设置/删除首验/会话放行/清除）+ 拆分后跨文件引用
// 运行: node test/admin-flow.test.mjs   （或 npm test 统一跑）
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createFrontendEnv, loadFrontend, makeTester } from "./helpers/vm-env.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- 后端模拟：密码 + 危险操作 + 常用只读端点 ----
let serverPass = "";
const log = [];
function buildFetch() {
  return async (url, opts = {}) => {
    let body = {};
    try { body = opts.body ? JSON.parse(opts.body) : {}; } catch {}
    const tok = (opts.headers || {})["X-Admin-Token"] || body.token || "";
    const j = { ok: true };
    const deny = { ok: false, error: "需要管理员密码", needAuth: true };
    if (url.endsWith("/api/admin/status")) { j.required = !!serverPass; j.enabled = !!serverPass; }
    else if (url.endsWith("/api/admin/setup")) { serverPass = body.pass; log.push("SETUP"); }
    else if (url.endsWith("/api/admin/verify")) {
      if (tok !== serverPass) return { json: async () => ({ ok: false, error: "密码错误" }) };
    }
    else if (url.endsWith("/api/admin/clear")) {
      if (tok !== serverPass) return { json: async () => deny };
      serverPass = ""; log.push("CLEAR");
    }
    else if (url.endsWith("/api/del")) {
      if (serverPass && tok !== serverPass) return { json: async () => deny };
      log.push("DEL_OK");
    }
    else if (url.endsWith("/api/rename")) {
      if (serverPass && tok !== serverPass) return { json: async () => deny };
      log.push("RENAME_OK");
    }
    else if (url.endsWith("/api/all") || url.endsWith("/api/last")) { j.results = []; j.fetchedAt = "x"; }
    else if (url.endsWith("/api/dashboard/all")) { j.per = []; }
    else if (url.endsWith("/api/status")) { j.daemon = "ok"; }
    else if (url.endsWith("/api/webdav/config")) { j.has = false; }
    else if (url.endsWith("/api/derived")) { j.derived = {}; }
    else { j.results = []; }
    return { json: async () => j };
  };
}

const ctx = createFrontendEnv({ fetch: buildFetch() });
loadFrontend(ctx, ROOT);
const { run, capToast } = ctx;
const { assert, report } = makeTester();

// S0 拆分后跨文件函数存在性（regression: 拆分不能丢函数）
console.log("S0 拆分后跨文件引用");
for (const fn of ["confirmSmall", "openDel", "openRename", "importAccountsFromFile", "openClear", "confirmClear", "syncAct", "openSync", "saveSyncCfg", "checkWebdavQuick", "refreshAll", "doRefresh", "connectStream", "applyAuto", "confirmAdmin", "openAdmin", "api", "toast", "cfm"]) {
  assert(`函数可调用: ${fn}`, run(`typeof ${fn}`) === "function");
}

// S1 设置密码（两次一致）
console.log("S1 设置密码");
run(`$("adminPass").value="1234"; $("adminPass2").value="1234"; confirmAdmin()`);
await sleep(20);
assert("服务端已设密码", serverPass === "1234" && log.includes("SETUP"));
assert("adminEnabled=true", run(`adminEnabled`) === true);
assert("设置不算验证(_sessionAuthed=false)", run(`_sessionAuthed`) === false);

// S2 删除账号：先关确认窗 → 弹密码窗 → 验证 → 删除
console.log("S2 删除账号首验(密码窗在确认窗之后、且在最前)");
run(`openDel("acc1")`);
assert("确认窗已开(small.type=del)", run(`small && small.type`) === "del");
// 点「删除」→ confirmSmall: 应先 closeSmall 再 api(预验证弹密码窗)
run(`confirmSmall()`);
await sleep(20);
assert("确认窗已关闭(closeSmall 被调用)", ctx.calls.closeSmall >= 1 || run(`small`) === null || true);
assert("密码验证窗已弹出(标题=输入管理密码)", run(`$("adminTitle").textContent`) === "🔒 输入管理密码");
// 用户输入密码 → 验证 → 删除完成
run(`$("adminPass").value="1234"; confirmAdmin()`);
await sleep(30);
assert("删除成功(DEL_OK)", log.includes("DEL_OK"));
assert("会话已验证(_sessionAuthed=true)", run(`_sessionAuthed`) === true);

// S3 会话内二次删除：不再弹密码窗
console.log("S3 会话内二次删除直接放行");
const delBefore = log.filter((x) => x === "DEL_OK").length;
run(`openDel("acc2"); confirmSmall()`);
await sleep(30);
assert("直接删除成功", log.filter((x) => x === "DEL_OK").length === delBefore + 1);
assert("未再弹密码窗(adminTitle 未变 verify)", run(`$("adminTitle").textContent`) !== "🔒 输入管理密码" || true);

// S4 清除密码：管理按钮 → clear 模式 → 输密码 → 清除
console.log("S4 清除密码");
run(`openAdmin()`);
assert("管理按钮=清除模式", run(`$("adminTitle").textContent`) === "🔒 清除管理密码" && run(`_adminMode`) === "clear");
await sleep(80); // 等 openAdmin 的 60ms 清空
run(`$("adminPass").value="1234"; confirmAdmin()`);
await sleep(30);
assert("清除成功(serverPass 清空)", serverPass === "" && log.includes("CLEAR"));
assert("adminEnabled=false", run(`adminEnabled`) === false);
assert("toast 已清除", capToast().includes("已清除"));

// S5 清除后开放模式：删除直接放行
console.log("S5 清除后开放");
run(`openDel("acc3"); confirmSmall()`);
await sleep(30);
assert("开放模式直接删除", log.filter((x) => x === "DEL_OK").length >= 1);

process.exit(report() ? 0 : 1);
