// edge-cdp2.mjs - 通过 CDP 控制本地 Edge(适用于 edge://inspect 勾选开启的调试模式)
// 连接方式:读取 DevToolsActivePort 文件 → 浏览器级 WebSocket → Target API 操作页面
// 用法:
//   node edge-cdp2.mjs list                         列出所有页面
//   node edge-cdp2.mjs eval <idx|targetId> <js>     在页面执行 JS
//   node edge-cdp2.mjs nav <idx|targetId> <url>     页面导航
//   node edge-cdp2.mjs newtab <url>                 新开标签页
//   node edge-cdp2.mjs shot <idx|targetId> <out.png> 页面截图
//   node edge-cdp2.mjs close <idx|targetId>         关闭标签页
const fs = await import("node:fs");
const USER_DATA = "C:\\Users\\2504\\AppData\\Local\\Microsoft\\Edge\\User Data";

function readDevToolsActivePort() {
  const p = USER_DATA + "\\DevToolsActivePort";
  if (!fs.existsSync(p)) throw new Error("DevToolsActivePort not found: " + p);
  const [port, wsPath] = fs.readFileSync(p, "utf8").trim().split(/\r?\n/);
  return { port: parseInt(port, 10), wsPath };
}

async function main() {
  const [cmd, arg1, arg2] = process.argv.slice(2);
  const { port, wsPath } = readDevToolsActivePort();
  const ws = new WebSocket(`ws://127.0.0.1:${port}${wsPath}`);

  let msgId = 0;
  const pending = new Map(); // id -> {resolve, sessionId}
  const sessions = new Map(); // sessionId -> targetId
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      pending.get(m.id).resolve(m);
      pending.delete(m.id);
    }
    // flatten 模式下,attachToTarget 的 session 会收到自己的事件,忽略非请求响应
  };
  const send = (method, params = {}, sessionId) =>
    new Promise((resolve) => {
      const id = ++msgId;
      pending.set(id, { resolve });
      ws.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }));
    });
  await new Promise((r) => (ws.onopen = r));

  if (cmd === "list") {
    const { result } = await send("Target.getTargets");
    result.targetInfos
      .filter((t) => t.type === "page")
      .forEach((t, i) => console.log(`[${i}] ${t.targetId} | ${t.title.slice(0, 50)} | ${t.url.slice(0, 100)}`));
    console.log("total pages:", result.targetInfos.filter((t) => t.type === "page").length);
    ws.close();
    return;
  }

  // 找到目标页面
  const { result: listRes } = await send("Target.getTargets");
  const pages = listRes.targetInfos.filter((t) => t.type === "page");
  const target = /^\d+$/.test(String(arg1))
    ? pages[parseInt(arg1, 10)]
    : pages.find((t) => t.targetId === arg1 || t.url.includes(arg1));
  if (!target) throw new Error("target not found: " + arg1);

  const attach = await send("Target.attachToTarget", { targetId: target.targetId, flatten: true });
  const sid = attach.result.sessionId;

  if (cmd === "eval") {
    const r = await send("Runtime.evaluate", { expression: arg2, returnByValue: true, awaitPromise: true }, sid);
    console.log(JSON.stringify(r.result, null, 2));
  } else if (cmd === "nav") {
    await send("Page.enable", {}, sid);
    const r = await send("Page.navigate", { url: arg2 }, sid);
    console.log("navigating:", JSON.stringify(r.result || r.error));
  } else if (cmd === "shot") {
    await send("Page.enable", {}, sid);
    const r = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false }, sid);
    fs.writeFileSync(arg2, Buffer.from(r.result.data, "base64"));
    console.log("saved:", arg2);
  } else if (cmd === "close") {
    await send("Target.closeTarget", { targetId: target.targetId });
    console.log("closed:", target.targetId);
  } else if (cmd === "newtab") {
    const r = await send("Target.createTarget", { url: arg1 });
    console.log("opened:", r.result.targetId);
  } else {
    throw new Error("unknown cmd: " + cmd);
  }
  ws.close();
}

main().catch((e) => {
  console.error("ERR:", e.message);
  process.exit(1);
});
