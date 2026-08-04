// test/server-routes.test.mjs — 后端路由冒烟测试（临时副本起服务,不碰真实库）
// 重点: 7 个前端文件必须由服务端真实提供(防"拆分后漏加静态路由"类回归) + 关键 API 可达。
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

let passed = 0, failed = 0;
const assert = (n, c, x = "") => { if (c) { passed++; console.log("  PASS " + n); } else { failed++; console.log("  FAIL " + n + (x ? "  << " + x : "")); } };

const PORT = 8097;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wb-route-test-"));
// 复制运行所需文件(数据文件不在副本内 → 服务启动即"空库"状态,绝不触碰真实数据)
for (const f of fs.readdirSync(ROOT)) {
  if (/^wb-gui\.(state|core|render|chart|ops|sync|actions)\.js$/.test(f) || f === "wb-gui.mjs" || f === "wb-gui.html" || f === "package.json") {
    fs.copyFileSync(path.join(ROOT, f), path.join(tmp, f));
  }
}
fs.cpSync(path.join(ROOT, "src"), path.join(tmp, "src"), { recursive: true });

const server = spawn(process.execPath, ["wb-gui.mjs", String(PORT)], { cwd: tmp, stdio: ["ignore", "pipe", "pipe"] });
let out = "";
server.stdout.on("data", (d) => (out += d));
server.stderr.on("data", (d) => (out += d));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const get = async (p) => {
  try { return await fetch("http://127.0.0.1:" + PORT + p, { signal: AbortSignal.timeout(4000) }); }
  catch { return null; }
};

try {
  // 等服务就绪
  let ok = false;
  for (let i = 0; i < 15; i++) { const r = await get("/api/status"); if (r && r.status === 200) { ok = true; break; } await sleep(300); }
  assert("服务启动(HTTP 200)", ok, out.slice(0, 200));

  console.log("T1 7 个前端文件必须真实提供(防拆分后漏静态路由)");
  const checks = [
    ["wb-gui.state.js", "function derivedOf"],
    ["wb-gui.core.js", "function confirmAdmin"],
    ["wb-gui.render.js", "function renderGiftBuckets"],
    ["wb-gui.chart.js", "function barChart"],
    ["wb-gui.ops.js", "function confirmSmall"],
    ["wb-gui.sync.js", "function syncAct"],
    ["wb-gui.actions.js", "function refreshAll"],
  ];
  for (const [f, sig] of checks) {
    const r = await get("/" + f + "?v=v1.4.7");
    const body = r ? await r.text() : "";
    assert(f + " 返回 200 且含 " + sig.split(" ")[1], r && r.status === 200 && body.includes(sig), "status=" + (r && r.status) + " len=" + body.length);
    assert(f + " 非占位(// missing)", !body.trim().startsWith("// missing"));
  }

  console.log("T2 关键 API 可达");
  const admin = await get("/api/admin/status");
  assert("/api/admin/status 200", admin && admin.status === 200);
  const hist = await get("/api/history?account=none");
  assert("/api/history 未知账号 404(参数校验生效)", hist && hist.status === 404);
} finally {
  server.kill();
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
}

console.log(`\n===== ${passed} passed, ${failed} failed =====`);
process.exit(failed ? 1 : 0);
