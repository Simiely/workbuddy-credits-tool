// edge-daemon.mjs - 常驻 CDP 代理:保持一条浏览器连接,供本地 HTTP API 复用
// 解决:edge://inspect 授权机制按"每条连接"弹窗,此代理只连一次,弹窗仅首次出现
// 启动: node edge-daemon.mjs [port=9333]
// API:
//   GET  /status                  -> { connected, port }
//   GET  /tabs                    -> [{index, targetId, title, url}]
//   GET  /eval?target=0&expr=JS   -> Runtime.evaluate 结果
//   POST /cmd {method, params, targetId?} -> 任意 CDP 命令(targetId 自动 attach)
//   GET  /newtab?url=...          -> 新开标签页
import http from "node:http";
import fs from "node:fs";

const USER_DATA = "C:\\Users\\2504\\AppData\\Local\\Microsoft\\Edge\\User Data";
const PORT = parseInt(process.argv[2] || "9333", 10);
const CONNECT_TIMEOUT = 25000; // 超过则关闭重连(错过授权弹窗时重新触发)

let ws = null;
let connected = false;
let msgId = 0;
const pending = new Map();
const sessions = new Map(); // targetId -> sessionId

function readDevToolsActivePort() {
  const p = USER_DATA + "\\DevToolsActivePort";
  if (!fs.existsSync(p)) return null;
  const [port, wsPath] = fs.readFileSync(p, "utf8").trim().split(/\r?\n/);
  return { port: parseInt(port, 10), wsPath };
}

function connect() {
  const info = readDevToolsActivePort();
  if (!info) {
    console.log("[daemon] DevToolsActivePort not found, retry in 3s");
    return setTimeout(connect, 3000);
  }
  console.log("[daemon] connecting ws://127.0.0.1:" + info.port + info.wsPath);
  const sock = new WebSocket("ws://127.0.0.1:" + info.port + info.wsPath);
  let opened = false;
  const timer = setTimeout(() => {
    if (!opened) {
      console.log("[daemon] connect timeout (waiting for authorization in Edge?), retry");
      try { sock.close(); } catch {}
    }
  }, CONNECT_TIMEOUT);

  sock.onopen = () => {
    opened = true;
    clearTimeout(timer);
    ws = sock;
    connected = true;
    console.log("[daemon] CONNECTED (authorize once in Edge if prompted)");
  };
  sock.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m);
      pending.delete(m.id);
    }
  };
  sock.onclose = () => {
    clearTimeout(timer);
    ws = null;
    connected = false;
    console.log("[daemon] disconnected, retry in 3s");
    setTimeout(connect, 3000);
  };
  sock.onerror = () => {
    clearTimeout(timer);
    try { sock.close(); } catch {}
  };
}

function send(method, params = {}, sessionId) {
  return new Promise((resolve) => {
    if (!connected || !ws) return resolve({ error: { message: "not connected" } });
    const id = ++msgId;
    pending.set(id, resolve);
    ws.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }));
  });
}

async function getPages() {
  const r = await send("Target.getTargets");
  if (r.error) throw new Error(r.error.message);
  return r.result.targetInfos.filter((t) => t.type === "page");
}

async function attachAndSession(targetId) {
  if (sessions.has(targetId)) return sessions.get(targetId);
  const r = await send("Target.attachToTarget", { targetId, flatten: true });
  if (r.error || !r.result) throw new Error((r.error && r.error.message) || "attach failed");
  sessions.set(targetId, r.result.sessionId);
  return r.result.sessionId;
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  const json = (code, obj) => {
    res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(obj));
  };
  const handle = async () => {
    try {
      if (url.pathname === "/status") return json(200, { connected, port: PORT });
      if (url.pathname === "/tabs") {
        const pages = await getPages();
        return json(200, pages.map((t, i) => ({ index: i, targetId: t.targetId, title: t.title, url: t.url })));
      }
      if (url.pathname === "/eval") {
        const expr = url.searchParams.get("expr");
        if (!expr) return json(400, { error: "expr required" });
        const target = url.searchParams.get("target") || "0";
        const pages = await getPages();
        const t = /^\d+$/.test(target)
          ? pages[parseInt(target, 10)]
          : pages.find((p) => p.targetId === target || p.url.includes(target));
        if (!t) return json(404, { error: "target not found: " + target });
        const sid = await attachAndSession(t.targetId);
        const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }, sid);
        return json(200, r);
      }
      if (url.pathname === "/cmd" && req.method === "POST") {
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", async () => {
          try {
            const p = JSON.parse(body || "{}");
            if (p.targetId) {
              const sid = await attachAndSession(p.targetId);
              return json(200, await send(p.method, p.params || {}, sid));
            }
            return json(200, await send(p.method, p.params || {}));
          } catch (e) {
            json(500, { error: e.message });
          }
        });
        return;
      }
      if (url.pathname === "/newtab") {
        const r = await send("Target.createTarget", { url: url.searchParams.get("url") || "about:blank" });
        return json(200, r);
      }
      json(404, { error: "unknown path: " + url.pathname });
    } catch (e) {
      json(500, { error: e.message });
    }
  };
  handle();
});

server.listen(PORT, "127.0.0.1", () => console.log("[daemon] HTTP API ready on http://127.0.0.1:" + PORT));
connect();
