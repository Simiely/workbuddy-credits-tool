// edge-cdp.mjs - 通过 Chrome DevTools Protocol 控制本地 Edge(调试端口 9222)
// 用法:
//   node edge-cdp.mjs list                                 列出所有页面
//   node edge-cdp.mjs eval <pageId|index> <jsCode>        在页面执行 JS 并返回结果
//   node edge-cdp.mjs shot <pageId|index> <out.png>       页面截图
//   node edge-cdp.mjs newtab <url>                        新开标签页
const CDP = "http://127.0.0.1:9222";

function findTab(list, key) {
  const pages = list.filter((t) => t.type === "page");
  if (key === undefined || key === null) return pages[0];
  if (/^\d+$/.test(String(key))) return pages[parseInt(key, 10)];
  return pages.find((t) => t.id === key || t.url.includes(key)) || null;
}

async function main() {
  const [cmd, arg1, arg2] = process.argv.slice(2);
  const list = await (await fetch(`${CDP}/json`)).json();

  if (cmd === "list") {
    list
      .filter((t) => t.type === "page")
      .forEach((t, i) => console.log(`[${i}] ${t.id} | ${t.title.slice(0, 60)} | ${t.url.slice(0, 120)}`));
    return;
  }

  const tab = findTab(list, arg1);
  if (!tab) throw new Error("tab not found: " + arg1);

  const ws = new WebSocket(tab.webSocketDebuggerUrl);
  let msgId = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m);
      pending.delete(m.id);
    }
  };
  const send = (method, params = {}) =>
    new Promise((resolve) => {
      const id = ++msgId;
      pending.set(id, resolve);
      ws.send(JSON.stringify({ id, method, params }));
    });
  await new Promise((r) => (ws.onopen = r));

  if (cmd === "eval") {
    const r = await send("Runtime.evaluate", {
      expression: arg2,
      returnByValue: true,
      awaitPromise: true,
    });
    console.log(JSON.stringify(r.result, null, 2));
  } else if (cmd === "shot") {
    await send("Page.enable");
    const r = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    const fs = await import("node:fs");
    fs.writeFileSync(arg2, Buffer.from(r.result.data, "base64"));
    console.log("saved:", arg2);
  } else if (cmd === "newtab") {
    const t = await (await fetch(`${CDP}/json/new?${encodeURIComponent(arg1)}`, { method: "PUT" })).json();
    console.log("opened:", t.id, t.url);
  } else {
    throw new Error("unknown cmd: " + cmd);
  }
  ws.close();
}

main().catch((e) => {
  console.error("ERR:", e.message);
  process.exit(1);
});
