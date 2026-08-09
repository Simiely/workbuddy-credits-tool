// 复现:墓碑过期后再次同步 → purge 在合并阶段清掉墓碑 → 上传不含墓碑 → 远端墓碑丢失 → 设备 C 复活
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wb-sync-bug-"));
fs.cpSync(path.join(ROOT, "src"), path.join(tmp, "src"), { recursive: true });
for (const f of ["wb-gui.mjs", "wb-gui.html", "package.json"]) {
  fs.copyFileSync(path.join(ROOT, f), path.join(tmp, f));
}

let passed = 0, failed = 0;
const assert = (n, c, x = "") => { if (c) { passed++; console.log("  PASS " + n); } else { failed++; console.log("  FAIL " + n + (x ? "  << " + x : "")); } };

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

const store = await import("file:///" + tmp.replace(/\\/g, "/") + "/src/compute/store.js");
const { getDb } = await import("file:///" + tmp.replace(/\\/g, "/") + "/src/store/db.js");
// 设备 A:alice(uin=1)活跃,已删除的 bob(uin=2)墓碑 31 天前(已过期)
store.saveAccounts([{ id: "a1", uin: "1", name: "alice", updatedAt: new Date(Date.now() - 40 * 86400000).toISOString(), cookieHeader: "ck_a" }]);
// 写一条 31 天前的过期墓碑(uin=2)
{
  const db = getDb();
  db.prepare("INSERT OR REPLACE INTO tombstones (uin, deletedAt) VALUES (?, ?)").run("2", new Date(Date.now() - 31 * 86400000).toISOString());
}

const PORT = 22000 + Math.floor(Math.random() * 8000);
const server = spawn(process.execPath, ["wb-gui.mjs", String(PORT)], {
  cwd: tmp, env: { ...process.env, WB_TOOLS_DIR: tmp }, stdio: ["ignore", "pipe", "pipe"],
});
let log = "";
server.stdout.on("data", (d) => (log += d));
server.stderr.on("data", (d) => (log += d));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
for (let i = 0; i < 20; i++) { const r = await api(PORT, "/api/status"); if (r.status === 200) break; await sleep(300); }

try {
  // 首次同步:上传含过期墓碑的备份
  let r = await api(PORT, "/api/webdav/config", { url: `http://127.0.0.1:${wdPort}/`, user: "u", pass: "p" });
  r = await api(PORT, "/api/webdav/sync", {});
  const accKey = [...webdav.keys()].find((k) => k.endsWith("wb-accounts.json"));
  let remote1 = JSON.parse(webdav.get(accKey).toString("utf8"));
  console.log("首次同步后远端墓碑:", JSON.stringify(remote1.tombstones || []));
  assert("首次同步后远端含 bob 墓碑", (remote1.tombstones || []).some((t) => t.uin === "2"));

  // 第二次同步(墓碑已过期 → purge 在合并阶段清掉 → 上传不含墓碑)
  r = await api(PORT, "/api/webdav/sync", {});
  const remote2 = JSON.parse(webdav.get(accKey).toString("utf8"));
  console.log("再次同步后远端墓碑:", JSON.stringify(remote2.tombstones || []));
  assert("再次同步后远端仍保留 bob 墓碑(删除标记不丢失)", (remote2.tombstones || []).some((t) => t.uin === "2"), "墓碑被 purge 丢失!");

  // 设备 C:全新设备,本地有旧 bob(50 天前保存),同步 → 应看到墓碑不复活
  store.saveAccounts([{ id: "c1", uin: "2", name: "bob", updatedAt: new Date(Date.now() - 50 * 86400000).toISOString(), cookieHeader: "ck_b" }]);
  const tombsBefore = store.loadTombstones().size;
  console.log("设备 C 本地墓碑表大小(before):", tombsBefore, "| 本地账号:", store.loadAccounts().map((a) => a.uin).join(","));
  r = await api(PORT, "/api/webdav/sync", {});
  const localAfter = store.loadAccounts().map((a) => a.uin).sort();
  console.log("设备 C 同步后本地账号:", localAfter.join(","), "| 墓碑表:", store.loadTombstones().size);
  assert("设备 C 的 bob(uin=2) 应为墓碑(删除不复活)", !localAfter.includes("2"), "bob 复活了!删除被撤销!");
} catch (e) {
  console.log("  FAIL 测试异常: " + e.message);
  console.log(log.slice(-800));
  failed++;
} finally {
  server.kill();
  wd.close();
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
}

console.log(`\n===== ${passed} passed, ${failed} failed =====`);
process.exit(failed ? 1 : 0);
