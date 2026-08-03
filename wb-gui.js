// wb-gui.js v2 — 极简可靠版:单一状态 S,按钮状态单点控制,统一请求封装
// 子路径挂载自适应:独立运行 __BASE__="" ;经工具中心 /tool/<id>/ 挂载时 = "/tool/<id>"
const __BASE__ = window.__BASE__ || "";
const $ = (id) => document.getElementById(id);
const fmt = (n) => Math.round((n || 0) * 100) / 100;
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

// ---- 统一请求:默认 15s 超时(批量刷新可传 timeout:30000)+ JSON + 错误抛出 ----
async function api(path, opts = {}) {
  const ctrl = new AbortController();
  const timeout = opts.timeout || 15000;
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    const r = await fetch(path, { ...opts, signal: ctrl.signal });
    const j = await r.json();
    if (!j.ok) throw new Error(j.error || "请求失败");
    return j;
  } catch (e) {
    throw new Error(e.name === "AbortError" ? "请求超时(" + Math.round(timeout / 1000) + "s)" : e.message);
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
// 设计:先显示本地缓存(秒开),再后台实时刷新覆盖;手动刷新则强制实时
async function refreshAll(manual) {
  if (busy) return;
  if (manual) {
    await doRefresh(true);
    return;
  }
  // 自动/首次:缓存先行,实时随后
  if (!S) await loadLast();      // 有缓存则秒开
  await doRefresh(false);
}

// 从本地缓存加载(离线可看,秒开)
async function loadLast() {
  try {
    const j = await api(__BASE__ + "/api/last");
    if (j.ok && j.results) {
      S = j;
      render();
      $("updated").textContent = "缓存 " + j.fetchedAt + " · 正在刷新…";
    }
  } catch {}
}

async function doRefresh(manual) {
  setBusy(true);
  try {
    const j = await api(__BASE__ + "/api/all", { timeout: 30000 });
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
  const exp3d = rs.reduce((s, r) => s + expiringInDays(r, 3), 0);
  let cls = "ok", sub = "✅ 一切正常";
  if (!rs.length) { cls = ""; sub = "账号池为空,点「＋ 添加当前账号」"; }
  else if (expN > 0) { cls = "bad"; sub = `⚠️ ${expN} 个凭证过期,需重新登录`; }
  else if (failN > 0) { cls = "warn"; sub = `${failN} 个账号查询失败`; }
  else sub = `✅ 一切正常 · ${okN}/${rs.length} 账号有效`;
  $("hero").innerHTML = `
    <div class="hcard total ${cls}"><span class="h-ico">🏦</span><div class="n" id="heroTotal">${rs.length ? fmt(total) : "—"}</div><div class="l">总剩余积分</div><div class="s">${sub}</div></div>
    <div class="hcard"><span class="h-ico">⏳</span><div class="n" id="heroExp3d">${rs.length ? fmt(exp3d) : "—"}</div><div class="l">近3天过期</div></div>
    <div class="hcard"><span class="h-ico">📉</span><div class="n" id="heroToday">0</div><div class="l">今日已用</div></div>
    <div class="hcard"><span class="h-ico">🔥</span><div class="n">${fmt(used)}</div><div class="l">累计已用</div></div>`;
}
// ---------- 过期统计工具 ----------
// 近 maxDays 天内过期的有效赠送包剩余积分合计
function expiringInDays(r, maxDays) {
  if (!r || !r.data) return 0;
  const now = new Date(); now.setHours(0, 0, 0, 0);
  const limit = new Date(now.getTime() + maxDays * 86400000); limit.setHours(23, 59, 59, 999);
  let sum = 0;
  for (const a of r.data.Accounts || []) {
    if (a.PackageName.includes("体验版")) continue;
    if (a.Status !== 0) continue;
    const dt = new Date((a.CycleEndTime || "").replace(" ", "T"));
    if (dt >= now && dt <= limit) sum += a.CapacityRemain || 0;
  }
  return sum;
}

// 按 uin 建立近1天/3天过期积分映射
function buildExpiryMap() {
  const map = {};
  const rs = (S && S.results) || [];
  for (const r of rs) {
    if (!r.data) continue;
    map[r.account.uin] = { expiring1d: expiringInDays(r, 1), expiring3d: expiringInDays(r, 3) };
  }
  return map;
}

// 各账号今日消耗映射(数据来自后端 per.todayUsed,避免重复计算)
function buildTodayUsedMap(per) {
  const map = {};
  for (const a of (per || [])) map[a.uin] = a.todayUsed || 0;
  return map;
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
      return `<div class="acct" data-id="${a.id}" draggable="true" onclick="openDetail('${a.id}')"><div class="acct-top">
        <div><div class="acct-name">${nm}</div><div class="acct-uin">Uin: ${a.uin || "?"}</div></div>
        <span class="remain" style="color:var(--${c});border-color:currentColor;background:transparent">${r.expired ? "⚠️ 凭证过期" : "❌ 失败"}</span></div>
        <div class="acct-rows"><div class="arow"><div class="l">${r.error || "查询失败"}</div></div></div>${foot}</div>`;
    }
    const bp = s.baseSize ? Math.min(100, (s.baseUsed / s.baseSize) * 100) : 0;
    const gp = s.giftSize ? Math.min(100, (s.giftUsed / s.giftSize) * 100) : 0;
    const baseNote = s.baseCycleEnd ? `(至 ${s.baseCycleEnd.slice(5, 10)})` : "";
    return `<div class="acct" data-id="${a.id}" data-uin="${a.uin}" draggable="true" onclick="openDetail('${a.id}')"><div class="acct-top">
      <div><div class="acct-name">${nm}</div><div class="acct-uin">Uin: ${a.uin || "?"}</div></div>
      <div class="remain"><span class="tt">💎 总剩余积分</span><span class="tn">${fmt(totalOf(s))}</span></div></div>
      <div class="acct-rows">
        <div class="arow"><div class="l"><span>🎁 体验版基础用量 ${baseNote}</span><b>剩余 ${s.baseRemain ?? "-"}</b></div>
          ${s.baseSize ? `<div class="meter ${bp > 85 ? "warn" : ""}"><i style="width:${bp}%"></i></div>` : ""}</div>
        <div class="arow"><div class="l"><span>📦 有效赠送包(${s.giftCount} 个)</span><b>剩余 ${s.giftRemain}</b></div>
          <div class="meter ${gp > 85 ? "warn" : ""}"><i style="width:${gp}%"></i></div></div>
        <div class="arow"><div class="l" style="color:var(--brand)"><div class="acct-today">今日消耗 —</div></div></div>
      </div>${foot}</div>`;
  }).join("");
  initDrag();
  $("foot").textContent = "数据来自 WorkBuddy 网页版接口 · 自动刷新 " + autoMin + " 分钟 · 凭证过期请重新登录后「添加当前账号」 · 卡片可拖动排序";
}

// ---- 卡片拖拽排序(顺序随账号池持久化,经 /api/reorder 保存) ----
let dragId = null;
let suppressClick = false; // 拖拽后抑制一次点击,避免误开明细
function initDrag() {
  const grid = $("grid");
  // 手机/触屏:HTML5 drag 不可用,禁用拖拽并提示用排序按钮
  const isTouch = window.matchMedia && window.matchMedia("(hover: none)").matches;
  if (isTouch) {
    grid.querySelectorAll(".acct").forEach((card) => { card.draggable = false; });
    return;
  }
  grid.querySelectorAll(".acct").forEach((card) => {
    card.addEventListener("dragstart", (e) => {
      dragId = card.dataset.id;
      suppressClick = true;
      setTimeout(() => { suppressClick = false; }, 0);
      card.classList.add("dragging");
      e.dataTransfer.effectAllowed = "move";
      try { e.dataTransfer.setData("text/plain", dragId); } catch {}
    });
    card.addEventListener("dragend", () => {
      dragId = null;
      card.classList.remove("dragging");
      grid.querySelectorAll(".acct").forEach((c) => c.classList.remove("drag-over"));
    });
    card.addEventListener("dragover", (e) => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; });
    card.addEventListener("dragenter", (e) => { e.preventDefault(); if (dragId && card.dataset.id !== dragId) card.classList.add("drag-over"); });
    card.addEventListener("dragleave", () => card.classList.remove("drag-over"));
    card.addEventListener("drop", (e) => {
      e.preventDefault();
      card.classList.remove("drag-over");
      if (!dragId || card.dataset.id === dragId) return;
      moveCard(dragId, card.dataset.id);
    });
  });
}
async function moveCard(fromId, toId) {
  const cards = [...$("grid").querySelectorAll(".acct")];
  const from = cards.find((c) => c.dataset.id === fromId);
  const to = cards.find((c) => c.dataset.id === toId);
  if (!from || !to) return;
  if (from.compareDocumentPosition(to) & Node.DOCUMENT_POSITION_FOLLOWING) to.after(from);
  else to.before(from);
  const ids = [...$("grid").querySelectorAll(".acct")].map((c) => c.dataset.id);
  try {
    const j = await api(__BASE__ + "/api/reorder", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ids }) });
    if (!j.ok) throw new Error(j.error || "保存失败");
    // 同步数据顺序(表格/后续渲染保持一致)
    const byId = new Map((S.results || []).map((r) => [r.account.id, r]));
    S.results = ids.map((id) => byId.get(id)).filter(Boolean);
    renderDash(); // 后端已保存新顺序,重拉仪表盘使表格/图例同步
    toast("✅ 卡片顺序已保存");
  } catch (e) {
    toast("❌ " + e.message);
    refreshAll(false); // 失败回滚到服务端顺序
  }
}

// ---- 一键排序:按指定指标从多到少(保存到账号池,与拖拽同机制) ----
// 过期分层:逐层扫描"近1天、近2天…"窗口,返回该账号最早出现过期量的层
const SCAN_MAX_DAYS = 30; // 逐层扫描上限(天),超过仍无过期量的账号视为"无到期压力",排最后
function expiryTier(r) {
  for (let d = 1; d <= SCAN_MAX_DAYS; d++) {
    const v = expiringInDays(r, d);
    if (v > 0) return { tier: d, amount: v };
  }
  return { tier: Infinity, amount: 0 };
}
// 保存排序结果 + 渲染 + 提示(排序与保存共用)
async function persistOrder(sorted, label) {
  S.results = sorted;
  renderCards();
  const ids = S.results.map((r) => r.account.id);
  try {
    const j = await api(__BASE__ + "/api/reorder", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ids }) });
    if (!j.ok) throw new Error(j.error || "保存失败");
    renderDash(); // 表格/折线图例同步
    toast(`✅ 已按${label}从多到少排序并保存`);
  } catch (e) {
    toast("❌ " + e.message);
    refreshAll(false); // 失败回滚
  }
}
async function sortByMetric(getV, label) {
  const rs = (S && S.results) || [];
  if (rs.length < 2) return toast("账号不足 2 个,无需排序");
  const sorted = [...rs].sort((a, b) => (getV(b) || 0) - (getV(a) || 0)); // 无值(失败/过期)视为 0,自然排最后
  await persistOrder(sorted, label);
}
function sortByTotal() { sortByMetric((r) => totalOf(r.summary), "总剩余"); }
// 过期排序:逐层紧迫度 —— 先排近1天有过期量的(量多优先);近1天没有的依次放宽到近2/近3…天,直到全部账号有序;无到期压力(>30天)按总剩余降序垫底
async function sortByExpiring() {
  const rs = (S && S.results) || [];
  if (rs.length < 2) return toast("账号不足 2 个,无需排序");
  const sorted = [...rs].sort((a, b) => {
    const ta = expiryTier(a), tb = expiryTier(b);
    if (ta.tier !== tb.tier) return ta.tier - tb.tier;       // 更紧迫的层在前
    if (ta.tier === Infinity) return totalOf(b.summary) - totalOf(a.summary); // 都无到期压力:按总剩余降序
    return tb.amount - ta.amount;                             // 同层按过期量从多到少
  });
  await persistOrder(sorted, "过期");
}

// ---- 仪表盘:表格 + 折线(异步加载,失败不阻塞) ----
async function renderDash() {
  try {
    const j = await api(__BASE__ + "/api/dashboard/all");
    dashPer = j.per || [];
    window._todayUsedMap = buildTodayUsedMap(dashPer);
    // hero 今日已用:直接从后端预计算的 todayUsed 汇总
    const totalUsed = dashPer.reduce((s, a) => s + (a.todayUsed || 0), 0);
    const prev = window._prevTodayUsed;
    let trendHtml = totalUsed > 0 ? fmt(totalUsed) : "0";
    if (prev !== undefined && totalUsed !== prev) {
      const delta = totalUsed - prev;
      const arrow = delta > 0 ? "↑" : "↓";
      const c = delta > 0 ? "var(--bad)" : "var(--ok)";
      trendHtml = `${fmt(totalUsed)} <span style="font-size:12px;color:${c}">${arrow}${fmt(Math.abs(delta))}</span>`;
    }
    window._prevTodayUsed = totalUsed;
    $("heroToday").innerHTML = trendHtml;
    updateCardsToday(); // 卡片上的今日消耗(异步,等 dashPer 加载后)
  } catch { return; }
  renderDashTable();
  renderLines();
  // 面板时间戳
  if (dashPer.length) {
    const lastTs = dashPer.reduce((m, a) => {
      const pts = a.series || [];
      return pts.length ? Math.max(m, ...pts.map((p) => new Date(p.t).getTime())) : m;
    }, 0);
    if (lastTs) $("dashMeta").textContent += " · " + new Date(lastTs).toLocaleString("zh-CN").slice(5);
  }
}
function updateCardsToday() {
  const map = window._todayUsedMap || {};
  document.querySelectorAll(".acct[data-uin]").forEach((c) => {
    const el = c.querySelector(".acct-today");
    if (el) el.textContent = "今日消耗 " + fmt(map[c.dataset.uin] || 0);
  });
}
function renderDashTable() {
  if (!dashPer.length) {
    $("dashCards").innerHTML = '<div class="ph" style="padding:24px">暂无账号</div>';
    $("dashTbody").innerHTML = '<tr><td colspan="7" class="ph">暂无账号</td></tr>';
    $("dashMeta").textContent = "";
    return;
  }
  const expMap = buildExpiryMap();
  const tuMap = window._todayUsedMap || {};
  // 凭证状态(来自 S.results,不在 dashPer 里)
  const credMap = {};
  for (const r of (S && S.results) || []) {
    credMap[r.account.uin] = { expired: !!r.expired, sessionExpiresAt: r.account.sessionExpiresAt };
  }
  // 单元格工具(卡片版)
  const cell = (label, val, color, bg, big) => `<div class="dcell ${bg}" ${color ? `style="--dc:var(--${color})"` : ""}>${big ? `<div class="dc-l">${label}</div><div class="dc-v big">${val}</div>` : `<div class="dc-l">${label}</div><div class="dc-v">${val}</div>`}</div>`;
  // ===== 手机卡片版(桌面隐藏) =====
  const cards = dashPer.map((a, i) => {
    const ex = expMap[a.uin] || {};
    const tu = tuMap[a.uin] || 0;
    const cred = credMap[a.uin] || {};
    const e1 = ex.expiring1d || 0, e3 = ex.expiring3d || 0;
    return `<div class="dacct">
      <div class="dhead">
        <span class="di">${i + 1}</span>
        <span class="dname">${acctName(a)}</span>
        ${cred.expired ? `<span class="dtag bad">⚠️</span>` : `<span class="dtag ok">✓</span>`}
      </div>
      <div class="dremain"><div class="dr-v">${fmt(a.currentRemain ?? "-")}</div><div class="dr-l">💎 总剩余</div></div>
      <div class="dgrid">
        ${cell("今日消耗", fmt(tu), "", "plain", false)}
        ${cell("累计已用", fmt(a.used ?? "-"), "", "plain", false)}
        ${cell("近1天过期", fmt(e1), e1 > 0 ? "warn" : "", e1 > 0 ? "warn" : "ok", e1 > 0)}
        ${cell("近3天过期", fmt(e3), e3 > 0 ? "warn" : "", e3 > 0 ? "warn" : "ok", e3 > 0)}
      </div>
    </div>`;
  }).join("");
  const sum = (k) => dashPer.reduce((s, x) => s + (x[k] || 0), 0);
  const sumExp1d = dashPer.reduce((s, a) => s + ((expMap[a.uin] || {}).expiring1d || 0), 0);
  const sumExp3d = dashPer.reduce((s, a) => s + ((expMap[a.uin] || {}).expiring3d || 0), 0);
  const sumTu = dashPer.reduce((s, a) => s + (tuMap[a.uin] || 0), 0);
  // 合计卡跨整行
  const total = `<div class="dacct dtot">
    <div class="dhead"><div class="dname" style="font-weight:800">📊 合计</div></div>
    <div class="dgrid">
      ${cell("今日消耗", fmt(sumTu), "", "plain", false)}
      ${cell("累计已用", fmt(sum("used")), "", "plain", false)}
      ${cell("近1天过期", fmt(sumExp1d), sumExp1d > 0 ? "warn" : "", sumExp1d > 0 ? "warn" : "ok", sumExp1d > 0)}
      ${cell("近3天过期", fmt(sumExp3d), sumExp3d > 0 ? "warn" : "", sumExp3d > 0 ? "warn" : "ok", sumExp3d > 0)}
    </div>
    <div class="dremain" style="background:none;border:none;padding:6px 0 0"><div class="dr-v" style="font-size:22px;background:var(--grad);-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent">${fmt(sum("currentRemain"))}</div><div class="dr-l">💎 总剩余</div></div>
  </div>`;
  $("dashCards").innerHTML = cards + total;
  // ===== 桌面表格版(手机隐藏) =====
  const rows = dashPer.map((a, i) => {
    const ex = expMap[a.uin] || {};
    return `<tr>
    <td class="num" style="color:var(--faint)">${i + 1}</td><td>${acctName(a)}</td>
    <td class="num"><b>${a.currentRemain ?? "-"}</b></td><td class="num">${a.used ?? "-"}</td>
    <td class="num">${tuMap[a.uin] > 0 ? fmt(tuMap[a.uin]) : "0"}</td>
    <td class="num" style="color:var(--${ex.expiring1d > 0 ? 'warn' : 'faint'})">${fmt(ex.expiring1d)}</td>
    <td class="num" style="color:var(--${ex.expiring3d > 0 ? 'warn' : 'faint'})${ex.expiring3d > 0 ? ';font-weight:800' : ''}">${fmt(ex.expiring3d)}</td></tr>`;
  }).join("");
  $("dashTbody").innerHTML = rows + `<tr style="border-top:2px solid var(--line2);font-weight:800">
    <td></td><td>合计</td><td class="num">${fmt(sum("currentRemain"))}</td><td class="num">${fmt(sum("used"))}</td>
    <td class="num">${fmt(sumTu)}</td><td class="num">${fmt(sumExp1d)}</td><td class="num">${fmt(sumExp3d)}</td></tr>`;
  $("dashMeta").textContent = dashPer.length + " 个账号";
}
function lineChart(series, mode) {
  const all = series.flatMap((s) => s.pts);
  if (!all.length) return '<div class="ph">暂无数据</div>';
  const times = [...new Set(all.map((p) => p.t))].sort();
  const vals = all.map((p) => p.v);
  const minV = Math.min(...vals), maxV = Math.max(...vals), range = maxV - minV || 1;
  const w = 640, h = 220, L = 44, R = 14, T = 34, B = 28, iw = w - L - R, ih = h - T - B;
  const X = (i) => times.length > 1 ? L + (i / (times.length - 1)) * iw : L + iw / 2;
  const Y = (v) => T + ih - ((v - minV) / range) * ih;
  let ticks = "";
  for (let k = 0; k <= 3; k++) {
    const v = minV + (maxV - minV) * k / 3, y = Y(v);
    ticks += `<line x1="${L - 6}" y1="${y}" x2="${L}" y2="${y}" stroke="rgba(255,255,255,.08)"/><text x="${L - 9}" y="${y + 4}" font-size="10" fill="#6b7484" text-anchor="end">${Math.round(v)}</text>`;
  }
  const step = Math.max(1, Math.ceil(times.length / 6));
  let xl = "";
  // X 轴标签 anchor:两端用 start/end 避开 Y 轴/右边界重叠(否则首日标签被 Y 轴"0"遮挡,看起来只显示 1 日)
  const xAnchor = (i) => i === 0 ? "start" : (i === times.length - 1 ? "end" : "middle");
  times.forEach((t, i) => { if (i % step === 0 || i === times.length - 1) { const p = t.slice(5, 10).split("-"); xl += `<text x="${X(i)}" y="${h - 8}" font-size="10" fill="#6b7484" text-anchor="${xAnchor(i)}">${mode === "month" ? parseInt(p[0],10) + "月" : parseInt(p[0],10) + "月" + parseInt(p[1],10) + "日"}</text>`; } });
  let paths = "";
  series.forEach((s, si) => {
    if (!s.pts.length) return;
    const color = LINE_COLORS[si % LINE_COLORS.length];
    if (s.pts.length === 1) {
      const p = s.pts[0]; const i = times.indexOf(p.t);
      if (i >= 0) { const x = X(i).toFixed(1), y = Y(p.v).toFixed(1);
        paths += `<g id="line-${s.key}"><title>${new Date(p.t).toLocaleString("zh-CN").slice(5)} 消耗 ${Math.round(p.v)}</title><circle cx="${x}" cy="${y}" r="1" fill="${color}"/><text x="${x}" y="${y - 8}" font-size="11" fill="${color}" text-anchor="middle">${Math.round(p.v)}</text></g>`; }
      return;
    }
    let d = "", pts = "", prevV = null;
    for (const p of s.pts) {
      const i = times.indexOf(p.t);
      if (i < 0) continue;
      const x = X(i).toFixed(1), y = Y(p.v).toFixed(1);
      d += (d ? "L" : "M") + x + "," + y;
      // 透明 hover 区(触屏/鼠标移到点附近显示大数字浮层);上升点补可见小圆
      pts += `<circle cx="${x}" cy="${y}" r="7" fill="transparent" class="cpt" data-v="${Math.round(p.v)}" data-t="${p.t}" data-n="${s.name || ""}"/>`;
      if (prevV !== null && p.v > prevV) {
        pts += `<circle cx="${x}" cy="${y}" r="2.5" fill="${color}"/>`;
      }
      prevV = p.v;
    }
    if (d) paths += `<g id="line-${s.key}"><path d="${d}" fill="none" stroke="${color}" stroke-width="1" vector-effect="non-scaling-stroke" stroke-dasharray="4 3" stroke-linejoin="round" stroke-linecap="round"/>${pts}</g>`;
  });
  const unit = mode === "month" ? "当月" : "当日";
  const note = `<text x="${w - R}" y="12" font-size="10" fill="#6b7484" text-anchor="end">● ${unit}有消耗</text>`;
  // 手机(<640px)不强制最小宽度,svg 撑满容器缩放
  const minW = window.innerWidth >= 640 ? 430 : 0;
  return `<svg viewBox="0 0 ${w} ${h}" style="width:100%;height:auto;min-width:${minW}px;display:block">${ticks}${paths}${xl}${note}</svg>`;
}
// 消耗聚合:按 keyFn 分组(day→YYYY-MM-DD,month→YYYY-MM),消耗=最早剩余−最晚剩余
function aggregateConsumption(pts, keyFn) {
  const firstOf = new Map(), lastOf = new Map();
  for (const p of pts) { const k = keyFn(p.t); if (!firstOf.has(k)) firstOf.set(k, p); lastOf.set(k, p); }
  return [...firstOf.keys()].sort().map((k) => ({ t: lastOf.get(k).t, v: (firstOf.get(k).v || 0) - (lastOf.get(k).v || 0) }));
}
function renderLines() {
  const raw = dashPer.filter((a) => (a.series || []).length >= 1);
  if (!raw.length) {
    $("legend").innerHTML = "";
    $("chart").innerHTML = '<div class="ph">暂无足够数据,多刷新几次后出现折线</div>';
    return;
  }
  const keyFn = dashMode === "day" ? (t) => t.slice(0, 10) : (t) => t.slice(0, 7);
  const lines = raw.map((a) => {
    const pts = (a.series || []).slice().sort((a, b) => a.t < b.t ? -1 : 1);
    const days = aggregateConsumption(pts, keyFn);
    return days.length ? { key: a.uin, name: acctName(a), pts: days } : null;
  }).filter(Boolean);
  if (!lines.length) {
    $("legend").innerHTML = "";
    $("chart").innerHTML = '<div class="ph">暂无足够数据,多刷新几次后出现折线</div>';
    return;
  }
  $("legend").innerHTML = raw.map((a, i) => `<div class="lg" data-key="${a.uin}" onclick="toggleLine('${a.uin}', this)"><i style="background:${LINE_COLORS[i % LINE_COLORS.length]}"></i>${acctName(a)}</div>`).join("");
  $("chart").innerHTML = lineChart(lines, dashMode);
}
function toggleLine(key, el) {
  const p = document.getElementById("line-" + key);
  if (!p) return;
  p.style.display = p.style.display === "none" ? "" : "none";
  if (el) el.classList.toggle("off", p.style.display === "none");
}
function changeMode(mode) { dashMode = mode; $("btnDay").className = "btn btn-g"; $("btnMonth").className = "btn btn-g"; (dashMode === "day" ? $("btnDay") : $("btnMonth")).classList.add("active"); renderLines(); }

// ---- 明细弹窗 ----
function closeModal() { $("mask").classList.remove("show"); }
function openDetail(id) {
  if (suppressClick) return; // 拖拽后抑制误触点击
  const r = (S && S.results || []).find((x) => x.account.id === id); // 用 id 定位,拖拽后不串位
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
  if (!bks.length) return '<div class="sect"><div class="stitle">📅 积分到期明细 <span class="sub">从今天起</span></div><div class="ph" style="padding:14px">无有效赠送包</div></div>';
  const t0 = new Date(); t0.setHours(0, 0, 0, 0);
  const dayDiff = (g) => { const d = new Date((g.CycleEndTime || "").replace(" ", "T")); return Math.max(0, Math.floor((new Date(d.getFullYear(), d.getMonth(), d.getDate()) - t0) / 86400000)); };
  const sumBy = (n) => { let t = 0, c = 0; for (const g of gifts) if (dayDiff(g) <= n) { t += g.CapacityRemain; c++; } return { t, c }; };
  const e1 = sumBy(1), e3 = sumBy(3); // 近1天/近3天到期(含今天)
  const max = Math.max(...bks.map((x) => x.total), e1.t, e3.t, 1);
  const bar = (label, e, color, bg, note) => `<div style="flex:1;min-width:52px;text-align:center"><div style="font-size:11px;font-weight:800;color:${color}">${fmt(e.t)}</div>
    <div style="height:90px;background:var(--chip);border-radius:6px;display:flex;align-items:flex-end;overflow:hidden;margin-top:4px"><div style="width:100%;background:${bg};height:${Math.max(4, (e.t / max) * 100)}%"></div></div>
    <div style="font-size:10px;color:var(--sub);margin-top:5px">${label}</div><div style="font-size:9px;color:var(--faint)">${e.c} 包${note ? " · " + note : ""}</div></div>`;
  const bars = [
    bar("1天到期", e1, "var(--bad)", "linear-gradient(180deg,var(--bad),#ff8f8f)", "今+明"),
    bar("3天到期", e3, "var(--warn)", "linear-gradient(180deg,var(--warn),#ffc08a)", "至3天后"),
    ...bks.map((b, i) => {
      return `<div style="flex:1;min-width:52px;text-align:center"><div style="font-size:11px;font-weight:800;color:${i === 0 ? "var(--warn)" : "var(--brand)"}">${fmt(b.total)}</div>
      <div style="height:90px;background:var(--chip);border-radius:6px;display:flex;align-items:flex-end;overflow:hidden;margin-top:4px"><div style="width:100%;background:${i === 0 ? "linear-gradient(180deg,var(--warn),#ffc08a)" : "var(--grad)"};height:${Math.max(4, (b.total / max) * 100)}%"></div></div>
      <div style="font-size:10px;color:var(--sub);margin-top:5px">${fmtD(b.start)}~${fmtD(b.end)}</div><div style="font-size:9px;color:var(--faint)">${b.count} 包</div></div>`;
    }),
  ].join("");
  return `<div class="sect"><div class="stitle">📅 积分到期明细 <span class="sub">从今天起</span></div>
    <div style="display:flex;gap:8px;overflow-x:auto;padding:6px 0">${bars}</div></div>`;
}
async function loadHist(uin) {
  try {
    const j = await api(__BASE__ + "/api/history?account=" + encodeURIComponent(uin));
    const h = j.history || [];
    const box = $("histBox");
    if (!box) return;
    if (!h.length) { box.innerHTML = '<div class="ph" style="padding:12px">暂无历史(每次成功刷新自动记录)</div>'; return; }
    // 按自然日聚合:每天取最早和最晚的快照,计算日消耗
    const byDay = {};
    for (const x of h) {
      const day = x.ts.slice(0, 10);
      if (!byDay[day]) byDay[day] = { first: x, last: x };
      else {
        if (x.ts < byDay[day].first.ts) byDay[day].first = x;
        if (x.ts > byDay[day].last.ts) byDay[day].last = x;
      }
    }
    const days = Object.entries(byDay)
      .sort((a, b) => b[0].localeCompare(a[0])) // 日期降序(最近在前)
      .map(([day, { first, last }]) => {
        const consumed = first.totalRemain - last.totalRemain;
        return { day, start: first.totalRemain, end: last.totalRemain, consumed };
      });
    const rows = days.map((d) => {
      const diff = d.consumed > 0 ? `<span style="color:var(--bad);font-weight:700">-${fmt(d.consumed)}</span>` : d.consumed === 0 ? "0" : `<span style="color:var(--ok)">+${fmt(Math.abs(d.consumed))}</span>`;
      return `<tr><td class="num" style="color:var(--faint)">${d.day}</td><td class="num">${fmt(d.start)}</td><td class="num"><b>${fmt(d.end)}</b></td><td>${diff}</td></tr>`;
    }).join("");
    box.innerHTML = `<div class="tbl" style="max-height:230px"><table style="min-width:0"><thead><tr><th>日期</th><th>起</th><th>终</th><th>日消耗</th></tr></thead><tbody>${rows}</tbody></table></div>`;
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

// 通用确认弹窗(Promise):resolve(true/false),替代原生 confirm
let cfmResolve = null;
function cfm(msg) {
  return new Promise((r) => {
    cfmResolve = r;
    openSmall("确认操作", `<div class="tip" style="color:var(--bad)">${msg}</div>
      <div class="factions"><button class="btn btn-g" onclick="cfmRes(false)">取消</button><button class="btn btn-d" style="min-height:38px;padding:9px 15px" onclick="cfmRes(true)">确认</button></div>`);
  });
}
function cfmRes(v) { closeSmall(); if (cfmResolve) { cfmResolve(v); cfmResolve = null; } }

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
      await api(__BASE__ + "/api/rename", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key: id, name }) });
      toast("已更新显示名称");
    } else {
      await api(__BASE__ + "/api/del", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key: id }) });
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
    const j = await api(__BASE__ + "/api/save-current", { method: "POST" });
    toast(`已保存账号[${j.account.name}]`);
    refreshAll(false);
  } catch (e) { toast("❌ " + e.message); }
  finally { b.disabled = false; b.textContent = "＋ 添加当前账号"; }
}
function exportMd() { window.location.href = __BASE__ + "/api/export.md"; }

// ---- daemon 探测 ----
async function checkDaemon() {
  try {
    const j = await api(__BASE__ + "/api/status");
    // 场景化提示:工具中心挂载时指向 edge-daemon 工具;独立运行时指向手动启动
    const tip = __BASE__
      ? "请先在工具中心「＋ 添加工具」接入 edge-daemon 工具(或保持其运行)。"
      : "请先启动 edge-daemon.mjs(node edge-daemon.mjs 8129)。";
    showDaemon(j.daemon !== "ok" ? `⚠️ 浏览器代理未运行:「添加当前账号」暂不可用(查询不受影响)。${tip}` : "");
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
$("syncPass") && $("syncPass").addEventListener("keydown", (e) => { if (e.key === "Enter") saveSyncCfg(); });

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
    const j = await api(__BASE__ + "/api/webdav/config");
    $("syncUrl").value = (j.url && j.url !== SYNC_DEFAULT_URL) ? j.url : "";
    $("syncUser").value = j.user || "";
    $("syncPass").value = "";
    if (j.has) { setSyncStatus("已保存配置,可直接上传/下载(如需改配置点「保存配置」)"); showSyncQuick(); }
    else setSyncStatus("尚未配置,填写后点「保存配置」");
  } catch (e) { setSyncStatus("❌ " + e.message); }
}
function closeSync() { $("syncMask").classList.remove("show"); }
const SYNC_DEFAULT_URL = atob("aHR0cHM6Ly93MmUwYjFkNmF2LmRkbnN0by5jb20v");
// 云同步配置:URL 为空时用默认(用于操作,不用于保存)
function syncCfg() {
  const url = ($("syncUrl").value || "").trim();
  return { url: url || SYNC_DEFAULT_URL, user: $("syncUser").value.trim(), pass: $("syncPass").value };
}
async function saveSyncCfg() {
  try {
    const url = ($("syncUrl").value || "").trim(); // 保存时原样(空即空)
    await api(__BASE__ + "/api/webdav/config", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url, user: $("syncUser").value.trim(), pass: $("syncPass").value }) });
    toast("✅ 配置已保存到本机");
    setSyncStatus("✅ 配置已保存,正在验证连接…");
    await syncAct("test", true);
  } catch (e) { toast("❌ " + e.message); }
}
async function syncAct(action, silent) {
  if (syncBusy) return;
  syncBusy = true;
  setSyncStatus(action === "test" ? "测试中…" : action === "upload" ? "上传中…" : action === "clear" ? "清空中…" : "下载中…");
  try {
    if (action === "download" && !await cfm("下载会覆盖本地的账号池/历史数据,确定继续吗?")) { setSyncStatus("已取消"); return; }
    if (action === "clear" && !await cfm("确认清空本地保存的 WebDAV 登录配置?")) { setSyncStatus("已取消"); return; }
    const j = await api(__BASE__ + "/api/webdav/" + action, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}) });
    if (action === "test") { showSyncQuick(); } // 登录成功 → 操作条云同步右侧出现上传/下载
    if (action === "clear") { $("syncQuick").hidden = true; closeSync(); }
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
  if (!await cfm(`确认永久清空:${names.join("、")}?此操作不可恢复!`)) return;
  try {
    const j = await api(__BASE__ + "/api/clear-data", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(sel) });
    closeClear();
    ["clearAccounts", "clearHistory", "clearCache"].forEach((id) => { $(id).checked = false; });
    toast(`已清空:${(j.cleared || []).join("、") || "无"}`);
    S = null;
    refreshAll(false);
  } catch (e) { toast("❌ " + e.message); }
}

// ---- 启动 ----
// 流程:先本地缓存秒开 → 后台实时刷新 → 其余初始化并行
refreshAll(false);
checkDaemon();
checkWebdavQuick();
applyAuto();

// ---- 折线图悬浮提示(事件委托,点 hover 显示大数字)----
const chartTip = $("chartTip");
if (chartTip) {
  const chartBox = () => ($("chart").closest(".pbody.line") || document.body).getBoundingClientRect();
  const placeTip = (e) => {
    const box = chartBox(), w = chartTip.offsetWidth, h = chartTip.offsetHeight;
    let lx = e.clientX - box.left + 14, ly = e.clientY - box.top - h - 8;
    if (lx + w > box.width - 4) lx = e.clientX - box.left - w - 14;
    if (ly < 4) ly = e.clientY - box.top + 18;
    chartTip.style.left = lx + "px";
    chartTip.style.top = ly + "px";
  };
  document.addEventListener("mouseover", (e) => {
    const el = e.target.closest && e.target.closest(".cpt");
    if (!el) return;
    chartTip.hidden = false;
    chartTip.innerHTML = `<div class="ct-v">${el.dataset.v}</div><div class="ct-s">${el.dataset.n ? el.dataset.n + " · " : ""}${new Date(el.dataset.t).toLocaleString("zh-CN").slice(5)}</div>`;
    placeTip(e);
  });
  document.addEventListener("mousemove", (e) => { if (!chartTip.hidden) placeTip(e); });
  document.addEventListener("mouseout", (e) => { if (e.target.closest && e.target.closest(".cpt")) chartTip.hidden = true; });
}

// 若已配置过 WebDAV,操作条云同步右侧直接显示上传/下载
async function checkWebdavQuick() {
  try {
    const j = await api(__BASE__ + "/api/webdav/config");
    if (j.has) showSyncQuick();
  } catch {}
}
