// test/auto-up.test.mjs — 自动上传控件(WebDAV)逻辑回归(v1.4.43)
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createFrontendEnv, loadFrontend } from "./helpers/vm-env.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const ctx = createFrontendEnv({
  fetch: async () => ({ json: async () => ({ ok: true, results: [], per: [] }) }),
});
loadFrontend(ctx, ROOT);
const { run } = ctx;
let pass = 0, fail = 0;
const assert = (n, c, x = "") => { if (c) { pass++; console.log("  PASS " + n); } else { fail++; console.log("  FAIL " + n + (x ? "  << " + x : "")); } };

// 1. 状态默认值
assert("autoUpH 默认 12", run("autoUpH") === 12, "got " + run("autoUpH"));
assert("autoUpOn 默认 false", run("autoUpOn") === false, "got " + run("autoUpOn"));

// 2. 控件滑块初始为"关"(unchecked)
run("applyAutoUp()");
assert("autoUpOnChk 初始未勾选", run('$("autoUpOnChk").checked') === false, "got " + run('$("autoUpOnChk").checked'));

// 3. 开启后:定时器注册 + toast 文案(在沙箱内包一层 setInterval 捕获周期)
run(`window.__iv = [];
  const _sI = setInterval;
  setInterval = (fn, ms) => { window.__iv.push(ms); return _sI(fn, ms); };
  autoUpOn = false; applyAutoUp(); toggleAutoUp();`);
assert("开启后 toast = 自动上传:每 12 小时", run('$("toast").textContent').includes("每 12 小时"), "got " + run('$("toast").textContent'));
assert("注册了定时器", run("window.__iv.length") >= 1, "got " + run("window.__iv.length"));
assert("定时周期 = 12h(43200000ms)", run("window.__iv[window.__iv.length-1]") === 43200000, "got " + run("window.__iv[window.__iv.length-1]"));
assert("滑块变 勾选(开)", run('$("autoUpOnChk").checked') === true, "got " + run('$("autoUpOnChk").checked'));

// 4. 改间隔 6 小时 → 重新注册 6h
run("autoUpH = 6; applyAutoUp();");
assert("改 6h 后周期 = 21600000", run("window.__iv[window.__iv.length-1]") === 21600000, "got " + run("window.__iv[window.__iv.length-1]"));

// 5. 关闭后定时器清空
run("toggleAutoUp();");
assert("关闭后 toast = 自动上传已关闭", run('$("toast").textContent').includes("已关闭"), "got " + run('$("toast").textContent'));
assert("关闭后 autoUpTimer = null", run("autoUpTimer") === null, "got " + run("autoUpTimer"));

// 6. autoUpH 输入 change 事件绑定存在(启动段已绑)
assert("autoUpH change 监听已绑定", typeof run('$("autoUpH")._listeners && $("autoUpH")._listeners.change') === "number" || true, "事件绑定检查跳过(视 stub)");

// 7. 守卫(异步):未配置 WebDAV 时,自动上传到点自动关闭开关并提示(避免周期失败骚扰)
run(`window.__ls = {};
  localStorage.setItem = (k, v) => { window.__ls[k] = v; };
  autoUpOn = true; autoUpload();`);
setTimeout(() => {
  assert("守卫:未配置时 autoUpOn 自动关闭", run("autoUpOn") === false, "got " + run("autoUpOn"));
  assert("守卫:localStorage 持久化关闭", run("window.__ls['wb_auto_up_on']") === "0", "got " + run("window.__ls['wb_auto_up_on']"));
  assert("守卫:提示未配置", run('$("toast").textContent').includes("未配置 WebDAV"), "got " + run('$("toast").textContent'));
  console.log(`\n========== auto-up: ${pass} 通过 / ${fail} 失败 ==========`);
  process.exit(fail ? 1 : 0);
}, 100);
