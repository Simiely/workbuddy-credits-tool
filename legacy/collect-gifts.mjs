// collect-gifts.mjs - 采集"权益赠送包"全部数据(弹窗内翻页)
// 通过 daemon HTTP API:打开弹窗 → 逐页采集 → CDP 真实鼠标点击翻页
const BASE = "http://127.0.0.1:9333";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const j = (r) => r.json();

async function evaljs(js) {
  const r = await j(await fetch(`${BASE}/eval?target=0&expr=${encodeURIComponent(js)}`));
  if (r.error) throw new Error(r.error.message);
  if (r.result && r.result.exceptionDetails) throw new Error("page js error: " + JSON.stringify(r.result.exceptionDetails).slice(0, 300));
  return JSON.parse(r.result.result.value);
}

async function main() {
  // 1. 获取页面 targetId
  const tabs = await j(await fetch(`${BASE}/tabs`));
  const tab = tabs.find((t) => t.url.includes("workbuddy")) || tabs[0];
  if (!tab) throw new Error("no page");
  console.error("[collect] using target:", tab.url);

  // 2. 打开权益赠送包弹窗(最后一个"查看全部")
  const openRes = await evaljs(`(() => {
    const els = [...document.querySelectorAll('*')].filter(e => e.children.length === 0 && e.textContent.trim() === '查看全部');
    if (!els.length) return JSON.stringify({ok:false, why:'no btn'});
    const t = els[els.length - 1];
    t.click();
    return JSON.stringify({ok:true});
  })()`);
  if (!openRes.ok) throw new Error("open dialog failed: " + openRes.why);
  await sleep(1500);

  // 3. 读取弹窗总计信息
  const summary = await evaljs(`(() => {
    const dlg = document.querySelector('.plans-usage-list-dialog-card');
    if (!dlg) return JSON.stringify({open:false});
    const t = dlg.innerText;
    const m = t.match(/([\\d.]+)\\/([\\d]+)积分（总计）/) || t.match(/([\\d.]+)\\/([\\d]+)积分/);
    return JSON.stringify({open:true, title: (dlg.querySelector('h1,h2,h3,div[class*=title],header')||{}).textContent || '', total: m ? m[0] : ''});
  })()`);
  console.error("[collect] dialog:", JSON.stringify(summary));
  if (!summary.open) throw new Error("dialog not open");

  // 4. 逐页采集
  const all = [];
  const seen = new Set();
  for (let page = 1; page <= 8; page++) {
    const rows = await evaljs(`JSON.stringify([...document.querySelectorAll('.plans-usage-list-dialog-card__row')].map(x => {
      const s = x.querySelectorAll('span');
      return s.length === 3 ? [s[0].textContent.trim(), s[1].textContent.trim(), s[2].textContent.trim()] : null;
    }).filter(Boolean))`);
    for (const [expire, source, usage] of rows) {
      const key = expire + "|" + usage;
      if (!seen.has(key)) { seen.add(key); all.push({ expire, source, usage }); }
    }
    // 定位弹窗内的下一页按钮(限定在弹窗容器)
    const nav = await evaljs(`new Promise(async (r) => {
      const b = document.querySelector('.plans-usage-list-dialog-card button[aria-label="下一页"]');
      if (!b) return r(JSON.stringify({has:false}));
      if (b.disabled) return r(JSON.stringify({has:true, disabled:true}));
      b.scrollIntoView({block:'center'});
      await new Promise(s => setTimeout(s, 400));
      const rc = b.getBoundingClientRect();
      const vh = window.innerHeight;
      const vis = rc.top >= 0 && rc.bottom <= vh;
      r(JSON.stringify({has:true, disabled:false, x: Math.round(rc.x + rc.width/2), y: Math.round(rc.y + rc.height/2), vis}));
    })`);
    if (!nav.has || nav.disabled) break;
    if (!nav.vis) { console.error("[collect] next btn not visible, stop"); break; }
    // CDP 真实鼠标点击
    for (const type of ["mousePressed", "mouseReleased"]) {
      await j(await fetch(`${BASE}/cmd`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ method: "Input.dispatchMouseEvent", params: { type, x: nav.x, y: nav.y, button: "left", clickCount: 1 }, targetId: tab.targetId }),
      }));
    }
    await sleep(1000);
    console.error("[collect] page", page, "collected", all.length, "rows");
  }

  console.log(JSON.stringify(all, null, 1));
}

main().catch((e) => {
  console.error("ERR:", e.message);
  process.exit(1);
});
