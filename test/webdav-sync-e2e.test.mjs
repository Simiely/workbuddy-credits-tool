// test/webdav-sync-e2e.test.mjs — 一键同步端到端(v1.4.46)
// 真实 wb-gui 服务 + mock WebDAV(内存),验证完整链路:
//   首次同步(远端空→只传) → 双向合并(远端新/本地独有) → 删除墓碑传播(另一设备不复活)
// 隔离:复制运行文件到临时目录 + WB_TOOLS_DIR 指向临时目录,不触碰真实数据。
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wb-sync-e2e-"));
fs.cpSync(path.join(ROOT, "src"), path.join(tmp, "src"), { recursive: true });
for (const f of ["wb-gui.mjs", "wb-gui.html", "package.json"]) {
  fs.copyFileSync(path.join(ROOT, f), path.join(tmp, f));
}

let passed = 0, failed = 0;
const assert = (n, c, x = "") => { if (c) { passed++; console.log("  PASS " + n); } else { failed++; console.log("  FAIL " + n + (x ? "  << " + x : "")); } };

// ---------- mock WebDAV(内存,随机端口) ----------
const webdav = new Map();
const wd = http.createServer((req, res) => {
  const p = decodeURIComponent(req.url.split("?")[0]);
  if (req.method === "MKCOL") { res.writeHead(201); res.end(); return; }
  if (req.method === "PUT") {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => { webdav.set(p, Buffer.concat(chunks)); res.writeHead(201); res.end(); });
    return;
  }
  if (req.method === "GET") {
    const b = webdav.get(p);
    if (b === undefined) { res.writeHead(404); res.end(); return; }
    res.writeHead(200); res.end(b);
    return;
  }
  res.writeHead(405); res.end();
});
await new Promise((r) => wd.listen(0, "127.0.0.1", r));
const wdPort = wd.address().port;

const api = async (port, p, body) => {
  try {
    const r = await fetch(`http://127.0.0.1:${port}${p}`, {
      method: body !== undefined ? "POST" : "GET",
      headers: body !== undefined ? { "Content-Type": "application/json" } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(8000),
    });
    return { status: r.status, j: await r.json().catch(() => null) };
  } catch { return { status: 0, j: null }; }
};

// ---------- 初始化本地账号(直接操作 tmp 库) ----------
const store = await import("file:///" + tmp.replace(/\\/g, "/") + "/src/compute/store.js");
store.saveAccounts([
  { id: "a1", uin: "1", name: "本地A", updatedAt: "2026-08-01T00:00:00.000Z", cookieHeader: "ck_a" },
  { id: "c1", uin: "3", name: "本地C", updatedAt: "2026-08-08T00:00:00.000Z", cookieHeader: "ck_c" },
]);

// ---------- 起真实服务(随机端口) ----------
const PORT = 21000 + Math.floor(Math.random() * 8000);
const server = spawn(process.execPath, ["wb-gui.mjs", String(PORT)], {
  cwd: tmp, env: { ...process.env, WB_TOOLS_DIR: tmp }, stdio: ["ignore", "pipe", "pipe"],
});
let log = "";
server.stdout.on("data", (d) => (log += d));
server.stderr.on("data", (d) => (log += d));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
for (let i = 0; i < 20; i++) { const r = await api(PORT, "/api/status"); if (r.status === 200) break; await sleep(300); }
assert("服务启动(HTTP 200)", (await api(PORT, "/api/status")).status === 200, log.slice(0, 300));

try {
  console.log("S1 保存配置 + 首次同步(远端空 → 只传)");
  let r = await api(PORT, "/api/webdav/config", { url: `http://127.0.0.1:${wdPort}/`, user: "u", pass: "p" });
  assert("保存配置 ok", r.j && r.j.ok === true);
  r = await api(PORT, "/api/webdav/sync", {});
  assert("首次同步 ok(first=true)", r.j && r.j.ok && r.j.first === true, JSON.stringify(r.j));
  assert("上传 2 个文件", r.j && r.j.pushed && r.j.pushed.length === 2, JSON.stringify(r.j && r.j.pushed));
  assert("mock 收到 wb-accounts.json", [...webdav.keys()].some((k) => k.endsWith("wb-accounts.json")));
  assert("mock 收到 wb-history.json", [...webdav.keys()].some((k) => k.endsWith("wb-history.json")));

  console.log("S2 双向合并:远端加 B(新),本地有 C;同步后本地=A+B+C");
  const accKey = [...webdav.keys()].find((k) => k.endsWith("wb-accounts.json"));
  const remote = JSON.parse(webdav.get(accKey).toString("utf8"));
  remote.accounts.push({ id: "b1", uin: "2", name: "远端B", updatedAt: "2026-08-08T00:00:00.000Z", cookieHeader: "ck_b" });
  webdav.set(accKey, Buffer.from(JSON.stringify(remote), "utf8"));
  r = await api(PORT, "/api/webdav/sync", {});
  assert("同步 ok", r.j && r.j.ok, JSON.stringify(r.j));
  assert("拉取合并 added=1(导入 B)", r.j.pulled && r.j.pulled.added === 1, JSON.stringify(r.j.pulled));
  assert("本地=A+B+C", JSON.stringify(store.loadAccounts().map((a) => a.uin).sort()) === JSON.stringify(["1", "2", "3"]));
  const remoteAfter = JSON.parse(webdav.get(accKey).toString("utf8"));
  assert("远端=A+B+C(合并后全量)", JSON.stringify(remoteAfter.accounts.map((a) => a.uin).sort()) === JSON.stringify(["1", "2", "3"]));

  console.log("S3 删除墓碑传播:本地删 A → 远端无 A+墓碑;清空本地再同步 → A 不复活");
  const accs = store.loadAccounts();
  store.tombstoneUins(["1"]);
  store.saveAccounts(accs.filter((a) => a.uin !== "1"));
  r = await api(PORT, "/api/webdav/sync", {});
  assert("同步 ok", r.j && r.j.ok, JSON.stringify(r.j));
  const remote3 = JSON.parse(webdav.get(accKey).toString("utf8"));
  assert("远端已无 A", !remote3.accounts.some((a) => a.uin === "1"));
  assert("远端墓碑含 uin=1", (remote3.tombstones || []).some((t) => t.uin === "1"), JSON.stringify(remote3.tombstones));
  // 模拟另一台设备:本地清空 → 同步 → A 不应复活(B/C 导入)
  store.saveAccounts([]);
  r = await api(PORT, "/api/webdav/sync", {});
  const local3 = store.loadAccounts().map((a) => a.uin).sort();
  assert("另一设备同步后 A 不复活(B/C 在)", JSON.stringify(local3) === JSON.stringify(["2", "3"]), JSON.stringify(local3));

  console.log("S4 清空保护(v1.4.48):远端有账号但合并后本地为空(墓碑误删) → 拒绝上传");
  store.tombstoneUins(["2", "3"]); // 模拟误写墓碑(清空/误删) → 远端 [2,3] 全被删 → 本地空
  r = await api(PORT, "/api/webdav/sync", {});
  assert("同步报错(拒绝上传)", r.j && r.j.ok === false, JSON.stringify(r.j));
  const remote4 = JSON.parse(webdav.get(accKey).toString("utf8"));
  assert("云端未被清空(仍有 2 个账号)", (remote4.accounts || []).length >= 2, JSON.stringify((remote4.accounts || []).map((a) => a.uin)));

  console.log("S5 清空账号池不写墓碑(v1.4.48):本地重置不传播删除");
  const tombsBefore = store.loadTombstones().size; // S4 写的 2 条墓碑
  r = await api(PORT, "/api/clear-data", { accounts: true });
  assert("clear-data ok", r.j && r.j.ok, JSON.stringify(r.j));
  const tombsAfter = store.loadTombstones().size;
  assert("清空账号池不新增墓碑", tombsAfter === tombsBefore, `before=${tombsBefore} after=${tombsAfter}`);
  assert("本地账号池已清空", store.loadAccounts().length === 0);
} catch (e) {
  console.log("  FAIL 测试异常: " + e.message);
  console.log(log.slice(-600));
  failed++;
} finally {
  server.kill();
  wd.close();
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
}

console.log(`\n===== ${passed} passed, ${failed} failed =====`);
process.exit(failed ? 1 : 0);
