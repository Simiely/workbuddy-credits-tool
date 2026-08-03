// edge-ctl.mjs - 通过本地代理(edge-daemon.mjs)操作 Edge,不直接建立 CDP 连接
// 用法:
//   node edge-ctl.mjs list
//   node edge-ctl.mjs eval <idx|targetId|url-key> "<js>"
//   node edge-ctl.mjs nav <idx> <url>
//   node edge-ctl.mjs newtab <url>
//   node edge-ctl.mjs shot <idx> <out.png>
//   node edge-ctl.mjs close <idx>
const BASE = "http://127.0.0.1:9333";

async function main() {
  const [cmd, arg1, arg2] = process.argv.slice(2);
  const j = (r) => r.json();

  if (cmd === "list") {
    const tabs = await (await fetch(`${BASE}/tabs`)).json();
    tabs.forEach((t) => console.log(`[${t.index}] ${t.targetId} | ${t.title.slice(0, 50)} | ${t.url.slice(0, 100)}`));
    console.log("total:", tabs.length);
    return;
  }
  if (cmd === "eval") {
    const r = await j(await fetch(`${BASE}/eval?target=${encodeURIComponent(arg1)}&expr=${encodeURIComponent(arg2)}`));
    console.log(JSON.stringify(r, null, 2));
    return;
  }
  if (cmd === "newtab") {
    const r = await j(await fetch(`${BASE}/newtab?url=${encodeURIComponent(arg1)}`));
    console.log(JSON.stringify(r, null, 2));
    return;
  }
  if (cmd === "nav") {
    const tabs = await j(await fetch(`${BASE}/tabs`));
    const t = /^\d+$/.test(String(arg1)) ? tabs[parseInt(arg1, 10)] : tabs.find((x) => x.url.includes(arg1));
    if (!t) throw new Error("target not found: " + arg1);
    const r = await j(await fetch(`${BASE}/cmd`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ method: "Page.navigate", params: { url: arg2 }, targetId: t.targetId }),
    }));
    console.log(JSON.stringify(r, null, 2));
    return;
  }
  if (cmd === "shot") {
    const tabs = await j(await fetch(`${BASE}/tabs`));
    const t = /^\d+$/.test(String(arg1)) ? tabs[parseInt(arg1, 10)] : tabs.find((x) => x.url.includes(arg1));
    if (!t) throw new Error("target not found: " + arg1);
    const r = await j(await fetch(`${BASE}/cmd`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ method: "Page.captureScreenshot", params: { format: "png", captureBeyondViewport: false }, targetId: t.targetId }),
    }));
    if (r.result && r.result.data) {
      const fs = await import("node:fs");
      fs.writeFileSync(arg2, Buffer.from(r.result.data, "base64"));
      console.log("saved:", arg2);
    } else {
      console.log(JSON.stringify(r, null, 2));
    }
    return;
  }
  if (cmd === "close") {
    const tabs = await j(await fetch(`${BASE}/tabs`));
    const t = /^\d+$/.test(String(arg1)) ? tabs[parseInt(arg1, 10)] : tabs.find((x) => x.url.includes(arg1));
    if (!t) throw new Error("target not found: " + arg1);
    const r = await j(await fetch(`${BASE}/cmd`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ method: "Target.closeTarget", params: { targetId: t.targetId } }),
    }));
    console.log(JSON.stringify(r, null, 2));
    return;
  }
  // 通用:直接透传 CDP 命令
  if (cmd === "raw") {
    const r = await j(await fetch(`${BASE}/cmd`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: arg1,
    }));
    console.log(JSON.stringify(r, null, 2));
    return;
  }
  throw new Error("unknown cmd: " + cmd);
}

main().catch((e) => {
  console.error("ERR:", e.message);
  process.exit(1);
});
