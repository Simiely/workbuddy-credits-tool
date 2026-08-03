// wb-gui.js v2 — 极简可靠版:单一状态 S,按钮状态单点控制,统一请求封装
const $ = (id) => document.getElementById(id);
const fmt = (n) => Math.round((n || 0) * 100) / 100;
const shortName = (n) => (n || "").replace("CodeBuddy个人版国内运营裂变包", "裂变包").replace("CodeBuddy个人体验版", "体验版");
const acctName = (a) => (a && (a.displayName || "").trim()) || (a && a.name) || "账号";
const totalOf = (s) => (s ? (s.baseRemain ?? 0) + s.giftRemain : 0);
const LINE_COLORS = ["#ff9292", "#5ad8a6", "#f6bd16", "#e8684a", "#6dc8ec", "#9270ca", "#ff9d4d", "#269a99", "#ff99c3", "#8378ea"];

let S = null;        // 唯一数据源 {results:[{account,summary,data}], fetchedAt}
let busy = false;    // 刷新锁
let dashPer = [];    // 仪表盘账号数据
let dashMode = "day";
let autoTimer = null;
let autoOn = localStorage.getItem("wb_auto_on") !== "0";
let autoMin = parseInt(localStorage.getItem("wb_auto_min") || "5", 10) || 5;
const LS_ON = "wb_auto_on", LS_MIN = "wb_auto_min";

// ---- 统一请求:15s 超时 + JSON + 错误抛出 ----
async function api(path, opts = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 15000);
  try {
    const r = await fetch(path, { ...opts, signal: ctrl.signal });
    const j = await r.json();
    if (!j.ok) throw new Error(j.error || "请求失败");
    return j;
  } catch (e) {
    throw new Error(e.name === "AbortError" ? "请求超时(15s)" : e.message);
  } finally { clearTimeout(t); }
}

// ---- 轻提示 ----
let toastTimer = null;
function toast(msg, ms = 2600) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), ms);
}
function showErr(msg) { const e = $("err"); e.hidden = !msg; e.textContent = msg || ""; }
function showDaemon(msg) { const w = $("daemonWarn"); w.hidden = !msg; w.textContent = msg || ""; }

// ---- 按钮状态单点控制(唯一改按钮的地方,finally 必恢复) ----
function setBusy(b) {
  busy = b;
  const btn = $("btnRefresh");
  if (!btn) return;
  btn.disabled = b;
  $("refreshSpin").hidden = !b;
  clearInterval(btn._t);
  if (b) {
    let s = 0;
    $("refreshTxt").textContent = "刷新中…";
    btn._t = setInterval(() => { s++; $("refreshTxt").textContent = "刷新中(" + s + "s)"; }, 1000);
  } else {
    $("refreshTxt").textContent = "刷新全部";
  }
}

// ---- 刷新(打开页面与手动共用) ----
async function refreshAll(manual) {
  if (busy) return;
  setBusy(true);
  try {
    const j = await api("/api/all");
    S = j;
    showErr("");
    render();
    $("updated").textContent = "更新于 " + j.fetchedAt;
    if (manual) {
      const rs = j.results || [];
      const ok = rs.filter((r) => r.summary).length;
      const ex = rs.filter((r) => r.expired).length;
      toast(`✅ 刷新成功(${ok}/${rs.length} 个账号${ex ? "," + ex + " 个凭证过期" : ""})`);
    }
  } catch (e) {
    showErr("❌ " + e.message + (S && S.results ? "，已显示上次数据" : "，点击刷新重试"));
    if (S && S.results) render();
  } finally {
    setBusy(false);
  }
}

// ---- 渲染(全部从 S 读取) ----
function render() {
  renderHero();
  renderCards();
  renderDash();
}

function renderHero() {
  const rs = (S && S.results) || [];
  const okN = rs.filter((r) => r.summary).length;
  const expN = rs.filter((r) => r.expired).length;
  const failN = rs.length - okN;
  const total = rs.reduce((s, r) => s + (r.summary ? totalOf(r.summary) : 0), 0);
  const used = rs.reduce((s, r) => s + (r.summary ? (r.summary.baseUsed ?? 0) + r.summary.giftUsed : 0), 0);
  let cls = "ok", sub = "✅ 一切正常";
  if (!rs.length) { cls = ""; sub = "账号池为空,点「＋ 添加当前账号」"; }
  else if (expN > 0) { cls = "bad"; sub = `⚠️ ${expN} 个凭证过期,需重新登录`; }
  else if (failN > 0) { cls = "warn"; sub = `${failN} 个账号查询失败`; }
  else sub = `✅ 一切正常 · ${okN}/${rs.length} 账号有效`;
  $("hero").innerHTML = `
    <div class="hcard total ${cls}"><span class="h-ico">🏦</span><div class="n" id="heroTotal">${rs.length ? fmt(total) : "—"}</div><div class="l">总剩余积分</div><div class="s">${sub}</div></div>
    <div class="hcard"><span class="h-ico">👥</span><div class="n">${rs.length}</div><div class="l">账号</div></div>
    <div class="hcard"><span class="h-ico">🔥</span><div class="n">${fmt(used)}</div><div class="l">累计已用</div></div>
    <div class="hcard"><span class="h-ico">⚠️</span><div class="n" style="color:${expN ? "var(--bad)" : ""}">${expN}</div><div class="l">凭证过期</div></div>`;
}

function renderCards() {
  const rs = (S && S.results) || [];
  if (!rs.length) {
    $("grid").innerHTML = '<div class="empty"><div class="big">📭</div>账号池为空<br>点「＋ 添加当前账号」或命令行 wb-credits.bat save-current</div>';
    $("foot").textContent = "";
    return;
  }
  $("grid").innerHTML = rs.map((r, i) => {
    const a = r.account, s = r.summary;
    const exp = a.sessionExpiresAt ? new Date(a.sessionExpiresAt).toLocaleDateString("zh-CN") : "?";
    const nm = acctName(a);
    const foot = `<div class="acct-foot"><span class="exp">凭证至 ${exp}</span>
      <span class="acts"><button class="btn btn-d" onclick="event.stopPropagation();openRename('${a.id}')">改名</button>
      <button class="btn btn-d" onclick="event.stopPropagation();openDel('${a.id}')">删除</button></span></div>`;
    if (!s) {
      const c = r.expired ? "warn" : "bad";
      return `<div class="acct" onclick="openDetail(${i})"><div class="acct-top">
        <div><div class="acct-name">${nm}</div><div class="acct-uin">Uin: ${a.uin || "?"}</div></div>
        <span class="remain" style="color:var(--${c});border-color:currentColor;background:transparent">${r.expired ? "⚠️ 凭证过期" : "❌ 失败"}</span></div>
        <div class="acct-rows"><div class="arow"><div class="l">${r.error || "查询失败"}</div></div></div>${foot}</div>`;
    }
    const bp = s.baseSize ? Math.min(100, (s.baseUsed / s.baseSize) * 100) : 0;
    const gp = s.giftSize ? Math.min(100, (s.giftUsed / s.giftSize) * 100) : 0;
    const baseNote = s.baseCycleEnd ? `(至 ${s.baseCycleEnd.slice(5, 10)})` : "";
    return `<div class="acct" onclick="openDetail(${i})"><div class="acct-top">
      <div><div class="acct-name">${nm}</div><div class="acct-uin">Uin: ${a.uin || "?"}</div></div>
      <div class="remain"><span class="tt">💎 总剩余积分</span><span class="tn">${fmt(totalOf(s))}</span></div></div>
      <div class="acct-rows">
        <div class="arow"><div class="l"><span>🎁 体验版基础用量 ${baseNote}</span><b>剩余 ${s.baseRemain ?? "-"}</b></div>
          ${s.baseSize ? `<div class="meter ${bp > 85 ? "warn" : ""}"><i style="width:${bp}%"></i></div>` : ""}</div>
        <div class="arow"><div class="l"><span>📦 有效赠送包(${s.giftCount} 个)</span><b>剩余 ${s.giftRemain}</b></div>
          <div class="meter ${gp > 85 ? "warn" : ""}"><i style="width:${gp}%"></i></div></div>
      </div>${foot}</div>`;
  }).join("");
  $("foot").textContent = "数据来自 WorkBuddy 网页版接口 · 自动刷新 " + autoMin + " 分钟 · 凭证过期请重新登录后「添加当前账号」";
}

// ---- 仪表盘:表格 + 折线(异步加载,失败不阻塞) ----
async function renderDash() {
  try {
    const j = await api("/api/dashboard/all");
    dashPer = j.per || [];
  } catch { return; }
  renderDashTable();
  renderLines();
}
function renderDashTable() {
  if (!dashPer.length) { $("dashTbody").innerHTML = '<tr><td colspan="6" class="ph">暂无账号</td></tr>'; $("dashMeta").textContent = ""; return; }
  const rows = dashPer.map((a, i) => `<tr>
    <td class="num" style="color:var(--faint)">${i + 1}</td><td>${acctName(a)}</td>
    <td class="num"><b>${a.currentRemain ?? "-"}</b></td><td class="num">${a.used ?? "-"}</td>
    <td class="num">${a.points > 1 ? (a.consumed > 0 ? fmt(a.consumed) : "0") : "—"}</td>
    <td class="num" style="color:var(--faint)">${a.points}</td></tr>`).join("");
  const sum = (k) => dashPer.reduce((s, x) => s + (x[k] || 0), 0);
  $("dashTbody").innerHTML = rows + `<tr style="border-top:2px solid var(--line2);font-weight:800">
    <td></td><td>合计</td><td class="num">${fmt(sum("currentRemain"))}</td><td class="num">${fmt(sum("used"))}</td>
    <td class="num">${fmt(sum("consumed"))}</td><td class="num" style="color:var(--faint)">${dashPer.length} 账号</td></tr>`;
  $("dashMeta").textContent = dashPer.length + " 个账号";
}
function agg(pts, mode) {
  if (mode !== "day" && mode !== "month") return pts;
  const m = new Map();
  for (const p of pts) m.set(mode === "day" ? p.t.slice(0, 10) : p.t.slice(0, 7), p);
  return [...m.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([, p]) => ({ t: p.t, v: p.v }));
}
function lineChart(series) {
  const all = series.flatMap((s) => s.pts);
  if (!all.length) return '<div class="ph">暂无数据</div>';
  const times = [...new Set(all.map((p) => p.t))].sort();
  if (times.length < 2) return '<div class="ph">数据点不足,多刷新几次后出现折线</div>';
  const vals = all.map((p) => p.v);
  const minV = Math.min(...vals), maxV = Math.max(...vals), range = maxV - minV || 1;
  const w = 640, h = 210, L = 44, R = 14, T = 14, B = 26, iw = w - L - R, ih = h - T - B;
  const X = (i) => L + (i / (times.length - 1)) * iw;
  const Y = (v) => T + ih - ((v - minV) / range) * ih;
  let ticks = "";
  for (let k = 0; k <= 3; k++) {
    const v = minV + (maxV - minV) * k / 3, y = Y(v);
    ticks += `<line x1="${L - 6}" y1="${y}" x2="${L}" y2="${y}" stroke="rgba(255,255,255,.08)"/><text x="${L - 9}" y="${y + 4}" font-size="10" fill="#6b7484" text-anchor="end">${Math.round(v)}</text>`;
  }
  const step = Math.max(1, Math.ceil(times.length / 6));
  let xl = "";
  times.forEach((t, i) => { if (i % step === 0 || i === times.length - 1) xl += `<text x="${X(i)}" y="${h - 8}" font-size="10" fill="#6b7484" text-anchor="middle">${t.slice(5, 16)}</text>`; });
  let paths = "";
  series.forEach((s, si) => {
    if (s.pts.length < 2) return;
    let d = "";
    for (const p of s.pts) { const i = times.indexOf(p.t); if (i < 0) continue; d += (d ? "L" : "M") + X(i).toFixed(1) + "," + Y(p.v).toFixed(1); }
    if (d) paths += `<path id="line-${s.key}" d="${d}" fill="none" stroke="${LINE_COLORS[si % LINE_COLORS.length]}" stroke-width="2.4" stroke-linejoin="round" stroke-linecap="round"/>`;
  });
  return `<svg viewBox="0 0 ${w} ${h}" style="width:100%;height:auto;min-width:430px;display:block">${ticks}${paths}${xl}</svg>`;
}
function renderLines() {
  const withS = dashPer.map((a) => ({ ...a, series: agg(a.series || [], dashMode) })).filter((a) => a.series.length >= 2);
  if (!withS.length) {
    $("legend").innerHTML = "";
    $("chart").innerHTML = '<div class="ph">暂无足够数据,多刷新几次后出现折线</div>';
    return;
  }
  $("legend").innerHTML = withS.map((a, i) => `<div class="lg" data-key="${a.uin}" onclick="toggleLine('${a.uin}', this)"><i style="background:${LINE_COLORS[i % LINE_COLORS.length]}"></i>${acctName(a)}</div>`).join("");
  $("chart").innerHTML = lineChart(withS.map((a, i) => ({ key: a.uin, pts: a.series.map((x) => ({ t: x.t, v: x.v })) })));
}
function toggleLine(key, el) {
  const p = document.getElementById("line-" + key);
  if (!p) return;
  p.style.display = p.style.display === "none" ? "" : "none";
  if (el) el.classList.toggle("off", p.style.display === "none");
}
function changeMode() { dashMode = $("mode").value; renderLines(); }

// ---- 明细弹窗 ----
function closeModal() { $("mask").classList.remove("show"); }
function openDetail(idx) {
  const r = (S && S.results && S.results[idx]);
  if (!r || !r.summary || !r.data) return toast("该账号暂无数据,无法查看明细");
  $("mask").classList.add("show");
  $("mTitle").textContent = acctName(r.account) + " · 明细";
  const s = r.summary;
  const gifts = r.data.Accounts.filter((a) => !a.PackageName.includes("体验版"));
  const act = gifts.filter((a) => a.Status === 0).sort((a, b) => (a.CycleEndTime < b.CycleEndTime ? -1 : 1));
  const expC = gifts.filter((a) => a.Status !== 0).length;
  const baseNote = s.baseCycleEnd ? `(当月有效 · 至 ${s.baseCycleEnd.slice(5, 10)})` : "";
  $("mBody").innerHTML = `
    <div class="hint" style="margin-bottom:12px">数据时间: ${S.fetchedAt} · 点「刷新全部」获取最新</div>
    <div class="cards">
      <div class="mcard"><div class="l">🎁 体验版剩余 ${baseNote}</div><div class="v">${s.baseRemain ?? "-"}</div></div>
      <div class="mcard"><div class="l">📦 赠送包已用/总量</div><div class="v">${fmt(s.giftUsed)} / ${s.giftSize}</div></div>
      <div class="mcard"><div class="l">💝 赠送剩余</div><div class="v">${s.giftRemain}</div></div>
      <div class="mcard"><div class="l">💎 剩余总积分</div><div class="v">${fmt(totalOf(s))}</div><div class="s">体验版 ${s.baseRemain ?? 0} + 赠送 ${s.giftRemain} · 过期 ${expC}</div></div>
    </div>
    ${renderBuckets(act)}
    <div class="sect"><div class="stitle">📈 消耗历史 <span class="sub">剩余总积分变化</span></div><div id="histBox"><div class="ph" style="padding:14px">加载中…</div></div></div>`;
  loadHist(r.account.uin);
}
function buildBuckets(gifts) {
  const t0 = new Date(); t0.setHours(0, 0, 0, 0);
  const bks = []; let cur = null;
  for (const g of gifts) {
    const dt = new Date((g.CycleEndTime || "").replace(" ", "T"));
    const day = new Date(dt.getFullYear(), dt.getMonth(), dt.getDate());
    const diff = Math.max(0, Math.floor((day - t0) / 86400000));
    const bi = Math.floor(diff / 7);
    if (!cur || cur.idx !== bi) {
      cur = { idx: bi, start: new Date(t0.getTime() + bi * 7 * 86400000), end: new Date(t0.getTime() + (bi * 7 + 6) * 86400000), total: 0, count: 0, days: new Map() };
      bks.push(cur);
    }
    cur.total += g.CapacityRemain; cur.count++;
    const dk = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`;
    if (!cur.days.has(dk)) cur.days.set(dk, []);
    cur.days.get(dk).push(g);
  }
  return bks;
}
const fmtD = (d) => `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
function renderBuckets(gifts) {
  const bks = buildBuckets(gifts);
  if (!bks.length) return '<div class="sect"><div class="stitle">📅 积分到期明细 <span class="sub">从今天起每 7 天</span></div><div class="ph" style="padding:14px">无有效赠送包</div></div>';
  const bars = bks.map((b, i) => {
    const max = Math.max(...bks.map((x) => x.total), 1);
    return `<div style="flex:1;min-width:52px;text-align:center"><div style="font-size:11px;font-weight:800;color:${i === 0 ? "var(--warn)" : "var(--brand)"}">${fmt(b.total)}</div>
      <div style="height:90px;background:var(--chip);border-radius:6px;display:flex;align-items:flex-end;overflow:hidden;margin-top:4px"><div style="width:100%;background:${i === 0 ? "linear-gradient(180deg,var(--warn),#ffc08a)" : "var(--grad)"};height:${Math.max(4, (b.total / max) * 100)}%"></div></div>
      <div style="font-size:10px;color:var(--sub);margin-top:5px">${fmtD(b.start)}~${fmtD(b.end)}</div><div style="font-size:9px;color:var(--faint)">${b.count} 包</div></div>`;
  }).join("");
  return `<div class="sect"><div class="stitle">📅 积分到期明细 <span class="sub">从今天起每 7 天</span></div>
    <div style="display:flex;gap:8px;overflow-x:auto;padding:6px 0">${bars}</div></div>`;
}
async function loadHist(uin) {
  try {
    const j = await api("/api/history?account=" + encodeURIComponent(uin));
    const h = j.history || [];
    const box = $("histBox");
    if (!box) return;
    if (!h.length) { box.innerHTML = '<div class="ph" style="padding:12px">暂无历史(每次成功刷新自动记录)</div>'; return; }
    let prev = null;
    const rows = h.map((x) => {
      const dt = x.ts.slice(0, 16).replace("T", " ");
      const diff = prev === null ? null : x.totalRemain - prev;
      const t = diff === null ? "—" : diff < 0 ? `<span style="color:var(--bad);font-weight:700">-${Math.abs(diff)}</span>` : "0";
      prev = x.totalRemain;
      return `<tr><td class="num" style="color:var(--faint)">${dt}</td><td class="num"><b>${fmt(x.totalRemain)}</b></td><td>${t}</td></tr>`;
    }).reverse().join("");
    box.innerHTML = `<div class="tbl" style="max-height:230px"><table style="min-width:0"><thead><tr><th>时间</th><th>剩余总积分</th><th>较上次</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  } catch {
    const box = $("histBox");
    if (box) box.innerHTML = '<div class="ph" style="padding:12px">历史加载失败</div>';
  }
}

// ---- 小弹窗(改名/删除) ----
let small = null;
function openSmall(title, bodyHtml) {
  $("smallTitle").textContent = title;
  $("smallBody").innerHTML = bodyHtml;
  $("smallMask").classList.add("show");
}
function closeSmall() { $("smallMask").classList.remove("show"); small = null; }

function openRename(id) {
  small = { type: "rename", id };
  const r = (S.results || []).find((x) => x.account.id === id);
  openSmall("修改显示名称", `<div class="tip">显示名称仅用于界面展示,不影响底层账号。</div>
    <input class="finput" id="renameInput" maxlength="30" value="${(r && (r.account.displayName || r.account.name)) || ""}">
    <div class="factions"><button class="btn btn-g" onclick="closeSmall()">取消</button><button class="btn btn-p" onclick="confirmSmall()">保存</button></div>`);
  setTimeout(() => { const i = $("renameInput"); if (i) { i.focus(); i.select(); } }, 60);
}
function openDel(id) {
  small = { type: "del", id };
  const r = (S.results || []).find((x) => x.account.id === id);
  openSmall("删除账号", `<div class="tip">确认删除账号[${r ? acctName(r.account) : ""}]?不可恢复,需重新登录找回。</div>
    <div class="factions"><button class="btn btn-g" onclick="closeSmall()">取消</button><button class="btn btn-d" style="min-height:38px;padding:9px 15px" onclick="confirmSmall()">删除</button></div>`);
}
async function confirmSmall() {
  if (!small) return;
  const { type, id } = small;
  try {
    if (type === "rename") {
      const name = $("renameInput").value.trim();
      await api("/api/rename", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key: id, name }) });
      toast("已更新显示名称");
    } else {
      await api("/api/del", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key: id }) });
      toast("已删除");
    }
    closeSmall();
    refreshAll(false);
  } catch (e) { toast("❌ " + e.message); }
}

// ---- 添加 / 导出 / 导入 ----
async function saveCurrent() {
  const b = $("btnAdd"); b.disabled = true; b.textContent = "保存中…";
  try {
    const j = await api("/api/save-current", { method: "POST" });
    toast(`已保存账号[${j.account.name}]`);
    refreshAll(false);
  } catch (e) { toast("❌ " + e.message); }
  finally { b.disabled = false; b.textContent = "＋ 添加当前账号"; }
}
function exportMd() { window.location.href = "/api/export.md"; }

// ---- daemon 探测 ----
async function checkDaemon() {
  try {
    const j = await api("/api/status");
    showDaemon(j.daemon !== "ok" ? "⚠️ 浏览器代理未运行:「添加当前账号」暂不可用(查询不受影响)。请重新运行 wb-gui.bat。" : "");
  } catch { }
}

// ---- 自动刷新 ----
function applyAuto() {
  clearInterval(autoTimer); autoTimer = null;
  $("btnAuto").textContent = autoOn ? "开" : "关";
  $("autoMin").value = autoMin;
  if (autoOn && autoMin > 0) autoTimer = setInterval(() => refreshAll(false), autoMin * 60000);
}
function toggleAuto() {
  autoOn = !autoOn;
  localStorage.setItem(LS_ON, autoOn ? "1" : "0");
  applyAuto();
  toast(autoOn ? `自动刷新:每 ${autoMin} 分钟` : "自动刷新已关闭");
}
$("autoMin").addEventListener("change", () => {
  const v = parseInt($("autoMin").value, 10);
  if (!v || v < 1) { $("autoMin").value = autoMin; return; }
  autoMin = v > 1440 ? 1440 : v;
  localStorage.setItem(LS_MIN, String(autoMin));
  applyAuto();
  toast(`间隔已设为 ${autoMin} 分钟`);
});
$("renameInput") && $("renameInput").addEventListener("keydown", (e) => { if (e.key === "Enter") confirmSmall(); if (e.key === "Escape") closeSmall(); });

// ---- WebDAV 云同步 ----
let syncBusy = false;
function setSyncStatus(msg) {
  const s = $("syncStatus");
  if (!s) return;
  s.textContent = msg;
  s.style.color = /✅|已|成功|覆盖/.test(msg) ? "var(--ok)" : /❌|失败|错误/.test(msg) ? "var(--bad)" : "var(--sub)";
}
function showSyncQuick() { const a = $("syncQuick"); if (a) a.hidden = false; } // 操作条:云同步右侧的上传/下载快捷按钮
async function openSync() {
  $("syncMask").classList.add("show");
  setSyncStatus("加载配置…");
  try {
    const j = await api("/api/webdav/config");
    $("syncUrl").value = j.url || "";
    $("syncUser").value = j.user || "";
    $("syncPass").value = "";
    if (j.has) { setSyncStatus("已保存配置,可直接上传/下载(如需改配置点「保存配置」)"); showSyncQuick(); }
    else setSyncStatus("尚未配置,填写后点「保存配置」");
  } catch (e) { setSyncStatus("❌ " + e.message); }
}
function closeSync() { $("syncMask").classList.remove("show"); }
function syncCfg() {
  return { url: $("syncUrl").value.trim(), user: $("syncUser").value.trim(), pass: $("syncPass").value };
}
async function saveSyncCfg() {
  try {
    await api("/api/webdav/config", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(syncCfg()) });
    toast("✅ 配置已保存到本机");
    setSyncStatus("✅ 配置已保存,正在验证连接…");
    await syncAct("test", true); // 保存后自动测试,成功即显示上传/下载
  } catch (e) { toast("❌ " + e.message); }
}
async function syncAct(action, silent) {
  if (syncBusy) return;
  syncBusy = true;
  setSyncStatus(action === "test" ? "测试中…" : action === "upload" ? "上传中…" : "下载中…");
  try {
    if (action === "download" && !confirm("下载会覆盖本地的账号池/历史数据,确定继续吗?")) { setSyncStatus("已取消"); return; }
    const j = await api("/api/webdav/" + action, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}) });
    if (action === "test") { showSyncQuick(); } // 登录成功 → 操作条云同步右侧出现上传/下载
    if (!silent) toast("✅ " + j.message);
    setSyncStatus("✅ " + j.message + (action === "download" && j.restored && j.restored.length ? ",请点「刷新全部」查看" : ""));
    if (action === "download" && j.restored && j.restored.length) refreshAll(false);
  } catch (e) {
    if (!silent) toast("❌ " + e.message);
    setSyncStatus("❌ " + e.message);
  } finally { syncBusy = false; }
}

// ---- 清空本地数据 ----
function openClear() { $("clearMask").classList.add("show"); }
function closeClear() { $("clearMask").classList.remove("show"); }
async function confirmClear() {
  const sel = { accounts: $("clearAccounts").checked, history: $("clearHistory").checked, cache: $("clearCache").checked };
  const names = [sel.accounts && "账号池", sel.history && "历史快照", sel.cache && "最近缓存"].filter(Boolean);
  if (!names.length) return toast("请至少勾选一项");
  if (!confirm(`确认永久清空:${names.join("、")}?此操作不可恢复!`)) return;
  try {
    const j = await api("/api/clear-data", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(sel) });
    closeClear();
    ["clearAccounts", "clearHistory", "clearCache"].forEach((id) => { $(id).checked = false; });
    toast(`已清空:${(j.cleared || []).join("、") || "无"}`);
    S = null;
    refreshAll(false);
  } catch (e) { toast("❌ " + e.message); }
}

// ---- 启动 ----
refreshAll(false);
renderDash();
checkDaemon();
checkWebdavQuick();
applyAuto();

// 若已配置过 WebDAV,操作条云同步右侧直接显示上传/下载
async function checkWebdavQuick() {
  try {
    const j = await api("/api/webdav/config");
    if (j.has) showSyncQuick();
  } catch {}
}
