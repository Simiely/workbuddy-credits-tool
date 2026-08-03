// wb-gui.js — 积分指挥中心 前端逻辑(全部功能:刷新/缓存/仪表盘/明细/账号管理/自动刷新)
const $ = (id) => document.getElementById(id);
let ALL = null;                 // 最近一次完整数据(结构同 /api/all)
let loadingAll = false;         // 刷新防重入
let DASH_PER = [];              // 仪表盘账号数据缓存
let dashMode = "day";           // 折线模式
let renameTarget = null, delTarget = null;
let autoTimer = null;
let autoOn = localStorage.getItem("wb_auto_on") !== "0";
let autoMin = parseInt(localStorage.getItem("wb_auto_min") || "5", 10) || 5;
const LS_ON = "wb_auto_on", LS_MIN = "wb_auto_min";
const fmt = (n) => Math.round((n || 0) * 100) / 100;
const shortName = (n) => (n || "").replace("CodeBuddy个人版国内运营裂变包", "裂变包").replace("CodeBuddy个人体验版", "体验版");
const acctName = (a) => (a && (a.displayName || "").trim()) || (a && a.name) || "账号";
const totalOf = (s) => (s ? (s.baseRemain ?? 0) + s.giftRemain : 0);
const LINE_COLORS = ["#ff9292", "#5ad8a6", "#f6bd16", "#e8684a", "#6dc8ec", "#9270ca", "#ff9d4d", "#269a99", "#ff99c3", "#8378ea"];

// ---------------- 轻提示 ----------------
let toastTimer = null;
function toast(msg, ms = 2600) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), ms);
}
function showErr(msg) { const e = $("err"); e.hidden = !msg; e.textContent = msg || ""; }

// ---------------- 刷新(短超时 + 进度显示,按钮保证恢复) ----------------
async function refreshAll(manual) {
  if (loadingAll) return;
  loadingAll = true;
  const spin = $("refreshSpin"), txt = $("refreshTxt");
  spin.hidden = false; txt.textContent = "刷新中…"; $("btnRefresh").disabled = true;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 12000); // 超时 12s,尽早恢复
  const tick = setInterval(() => { const s = Math.floor((Date.now() - startT) / 1000); if (txt) txt.textContent = `刷新中(${s}s)`; }, 1000);
  const startT = Date.now();
  try {
    const r = await fetch("/api/all", { signal: ctrl.signal });
    const j = await r.json();
    if (!j.ok) throw new Error(j.error || "查询失败");
    ALL = j;
    $("updated").textContent = "更新于 " + j.fetchedAt;
    showErr("");
    renderAll();
    if (manual) {
      const rs = j.results || [];
      const okN = rs.filter((r) => r.summary).length;
      const expN = rs.filter((r) => r.expired).length;
      toast(`✅ 刷新成功(${okN}/${rs.length} 个账号${expN ? "," + expN + " 个凭证过期" : ""})`);
    }
  } catch (e) {
    // 失败/超时:回退显示已有数据(缓存或旧数据),不白屏
    if (ALL && ALL.results) renderAll();
    showErr(e.name === "AbortError" ? "❌ 刷新超时(12 秒),已显示最近数据,请重试" : "❌ " + e.message + ",已显示最近数据");
  } finally {
    clearTimeout(timer);
    clearInterval(tick);
    loadingAll = false;
    spin.hidden = true; txt.textContent = "刷新全部"; $("btnRefresh").disabled = false;
  }
}

// 先显示本地缓存,再后台刷新
async function loadCache() {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 6000);
  try {
    const j = await (await fetch("/api/last", { signal: ctrl.signal })).json();
    if (j.ok && j.results && j.results.length) {
      ALL = j;
      $("updated").textContent = "缓存 " + j.fetchedAt + "(刷新中…)";
      renderAll();
    }
  } catch {}
  finally { clearTimeout(t); }
}

// ---------------- 渲染:总览 + 卡片 ----------------
function renderAll() {
  const rs = ALL.results || [];
  const okN = rs.filter((r) => r.summary).length;
  const expN = rs.filter((r) => r.expired).length;
  const failN = rs.length - okN;
  const total = rs.reduce((s, r) => s + (r.summary ? totalOf(r.summary) : 0), 0);
  const used = rs.reduce((s, r) => s + (r.summary ? (r.summary.baseUsed ?? 0) + r.summary.giftUsed : 0), 0);
  $("heroTotal").textContent = fmt(total);
  // 状态层:总剩余卡状态色 + 状态文本(倒金字塔第一层:5 秒判断"行不行")
  const totalCard = $("heroTotalCard");
  totalCard.classList.remove("warn", "bad");
  const sub = $("heroTotalSub");
  sub.classList.remove("ok", "warn", "bad");
  if (!rs.length) {
    sub.textContent = "账号池为空";
  } else if (expN > 0) {
    totalCard.classList.add("bad"); sub.classList.add("bad");
    sub.textContent = `⚠️ ${expN} 个凭证过期,需重新登录`;
  } else if (failN > 0) {
    totalCard.classList.add("warn"); sub.classList.add("warn");
    sub.textContent = `${failN} 个账号查询失败`;
  } else {
    sub.classList.add("ok");
    sub.textContent = `✅ 一切正常 · ${okN}/${rs.length} 账号有效`;
  }
  $("heroAccts").textContent = rs.length;
  $("heroConsumed").textContent = fmt(used);
  $("heroExpired").textContent = expN;
  $("heroExpired").style.color = expN ? "var(--bad)" : "";

  if (!rs.length) {
    $("grid").innerHTML = `<div class="empty"><div class="big">📭</div>账号池为空<br>点上方「＋ 添加当前账号」(需在 Edge 登录 WorkBuddy)<br>或命令行: wb-credits.bat save-current</div>`;
    $("foot").textContent = "";
    return;
  }
  $("grid").innerHTML = rs.map((r, i) => {
    const a = r.account, s = r.summary;
    const exp = a.sessionExpiresAt ? new Date(a.sessionExpiresAt).toLocaleDateString("zh-CN") : "?";
    const dn = (a.displayName || "").trim();
    const title = dn || a.name || ("账号" + (i + 1));
    if (!s) {
      const st = r.expired ? "warn" : "bad";
      return `<div class="acct" onclick="openDetail(${i})">
        <div class="acct-top"><div><div class="acct-name">${title}</div><div class="acct-uin">Uin: ${a.uin || "?"}</div></div>
          <span class="badge ${st}">${r.expired ? "⚠️ 凭证过期" : "❌ 查询失败"}</span></div>
        <div class="acct-rows"><div class="arow"><div class="l">${r.error || "查询失败"}</div></div></div>
        ${cardFoot(a.id, exp)}</div>`;
    }
    const bp = s.baseSize ? Math.min(100, s.baseUsed / s.baseSize * 100) : 0;
    const gp = s.giftSize ? Math.min(100, s.giftUsed / s.giftSize * 100) : 0;
    const baseNote = s.baseCycleEnd ? `(至 ${s.baseCycleEnd.slice(5, 10)})` : "";
    return `<div class="acct" onclick="openDetail(${i})">
      <div class="acct-top">
        <div><div class="acct-name">${title}</div><div class="acct-uin">Uin: ${a.uin || "?"}</div></div>
        <div class="remain-badge"><span class="tt">总剩余积分</span><span class="tn">${fmt(totalOf(s))}</span></div>
      </div>
      <div class="acct-rows">
        <div class="arow"><div class="l"><span>体验版基础用量 ${baseNote}</span><b>剩余 ${s.baseRemain ?? "-"}</b></div>
          ${s.baseSize ? `<div class="meter ${bp > 85 ? "warn" : ""}"><i style="width:${bp}%"></i></div>` : ""}</div>
        <div class="arow"><div class="l"><span>有效赠送包(${s.giftCount} 个)</span><b>剩余 ${s.giftRemain}</b></div>
          <div class="meter ${gp > 85 ? "warn" : ""}"><i style="width:${gp}%"></i></div></div>
      </div>
      ${cardFoot(a.id, exp)}</div>`;
  }).join("");
  $("foot").textContent = "数据来自 WorkBuddy 网页版接口 · 自动刷新 " + autoMin + " 分钟 · 凭证过期请重新登录后「添加当前账号」更新";
}

const cardFoot = (id, exp) => `<div class="acct-foot"><span class="exp">凭证至 ${exp}</span>
  <span class="acts">
    <button class="btn btn-ghost btn-sm" onclick="event.stopPropagation();openRename('${id}')">改名</button>
    <button class="btn btn-danger btn-sm" onclick="event.stopPropagation();openDel('${id}')">删除</button>
  </span></div>`;

// ---------------- 添加/导出/导入 ----------------
async function saveCurrent() {
  const b = $("btnAdd"); b.disabled = true; b.textContent = "保存中…";
  try {
    const j = await (await fetch("/api/save-current", { method: "POST" })).json();
    if (!j.ok) throw new Error(j.error);
    toast(`已保存账号[${j.account.name}]`);
    refreshAll(false);
  } catch (e) { toast("❌ " + e.message); }
  finally { b.disabled = false; b.textContent = "＋ 添加当前账号"; }
}
function exportCsv() { window.location.href = "/api/export.csv"; }
function exportConfig() { window.location.href = "/api/export-config"; toast("配置已导出(含凭证,请妥善保管)"); }
async function importConfig(input) {
  const file = input.files && input.files[0];
  input.value = "";
  if (!file) return;
  try {
    const j = await (await fetch("/api/import-config", { method: "POST", body: await file.text() })).json();
    if (!j.ok) throw new Error(j.error || "导入失败");
    toast(`导入成功:新增 ${j.added},跳过 ${j.skipped},现有 ${j.total}`);
    refreshAll(false);
  } catch (e) { toast("❌ " + e.message); }
}

// ---------------- daemon 探测 ----------------
async function checkDaemon() {
  try {
    const j = await (await fetch("/api/status")).json();
    const w = $("daemonWarn");
    if (j.ok && j.daemon !== "ok") {
      w.hidden = false;
      w.textContent = "⚠️ 浏览器代理(edge-daemon)未运行:「添加当前账号」暂不可用,查询不受影响。请重新运行 wb-gui.bat。";
    } else w.hidden = true;
  } catch {}
}

// ---------------- 自动刷新 ----------------
function applyAuto() {
  clearInterval(autoTimer); autoTimer = null;
  $("btnAuto").classList.toggle("on", autoOn);
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
$("renameInput").addEventListener("keydown", (e) => { if (e.key === "Enter") confirmRename(); if (e.key === "Escape") closeRename(); });

// ---------------- 改名 / 删除 ----------------
function openRename(id) {
  renameTarget = id;
  const r = (ALL.results || []).find((x) => x.account.id === id);
  $("renameInput").value = (r && (r.account.displayName || r.account.name)) || "";
  $("renameMask").classList.add("show");
  $("renameInput").focus(); $("renameInput").select();
}
function closeRename() { $("renameMask").classList.remove("show"); renameTarget = null; }
async function confirmRename() {
  const name = $("renameInput").value.trim();
  if (!renameTarget) return;
  try {
    const j = await (await fetch("/api/rename", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key: renameTarget, name }) })).json();
    if (!j.ok) throw new Error(j.error);
    closeRename(); toast("已更新显示名称"); refreshAll(false);
  } catch (e) { toast("❌ " + e.message); }
}
function openDel(id) {
  delTarget = id;
  const r = (ALL.results || []).find((x) => x.account.id === id);
  $("delTip").textContent = `确认删除账号[${r ? acctName(r.account) : ""}]?操作不可恢复,需重新登录才能找回。`;
  $("delMask").classList.add("show");
}
function closeDel() { $("delMask").classList.remove("show"); delTarget = null; }
async function confirmDel() {
  if (!delTarget) return;
  try {
    const j = await (await fetch("/api/del", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key: delTarget }) })).json();
    if (!j.ok) throw new Error(j.error || "删除失败");
    closeDel(); toast("已删除"); refreshAll(false);
  } catch (e) { toast("❌ " + e.message); }
}

// ---------------- 仪表盘(表格 + 折线) ----------------
function aggregateSeries(pts, mode) {
  if (mode !== "day" && mode !== "month") return pts;
  const map = new Map();
  for (const p of pts) { map.set(mode === "day" ? p.t.slice(0, 10) : p.t.slice(0, 7), p); }
  return [...map.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([, p]) => ({ t: p.t, v: p.v }));
}
function lineChartMulti(series) {
  const allPts = series.flatMap((s) => s.pts);
  if (!allPts.length) return '<div class="placeholder">暂无数据</div>';
  const times = [...new Set(allPts.map((p) => p.t))].sort();
  if (times.length < 2) return '<div class="placeholder">数据点不足,多刷新几次后出现折线(需 ≥2 个时间点)</div>';
  const vals = allPts.map((p) => p.v);
  const minV = Math.min(...vals), maxV = Math.max(...vals), range = maxV - minV || 1;
  const w = 640, h = 210, L = 44, R = 14, T = 14, B = 26;
  const iw = w - L - R, ih = h - T - B;
  const X = (i) => L + (i / (times.length - 1)) * iw;
  const Y = (v) => T + ih - ((v - minV) / range) * ih;
  const ticks = [];
  for (let k = 0; k <= 3; k++) {
    const v = minV + (maxV - minV) * k / 3, y = Y(v);
    ticks.push(`<line x1="${L - 6}" y1="${y}" x2="${L}" y2="${y}" stroke="rgba(255,255,255,.08)"/><text x="${L - 9}" y="${y + 4}" font-size="10" fill="#6b7484" text-anchor="end">${Math.round(v)}</text>`);
  }
  const step = Math.max(1, Math.ceil(times.length / 6));
  const xl = times.map((t, i) => (i % step === 0 || i === times.length - 1) ? `<text x="${X(i)}" y="${h - 8}" font-size="10" fill="#6b7484" text-anchor="middle">${t.slice(5, 16)}</text>` : "").join("");
  const paths = series.map((s, si) => {
    if (s.pts.length < 2) return "";
    let d = "";
    for (const p of s.pts) {
      const i = times.indexOf(p.t);
      if (i < 0) continue;
      d += (d ? "L" : "M") + X(i).toFixed(1) + "," + Y(p.v).toFixed(1);
    }
    if (!d) return "";
    const c = LINE_COLORS[si % LINE_COLORS.length];
    return `<path id="line-${s.key}" d="${d}" fill="none" stroke="${c}" stroke-width="2.4" stroke-linejoin="round" stroke-linecap="round" data-key="${s.key}"/>`;
  }).join("");
  return `<svg viewBox="0 0 ${w} ${h}" style="width:100%;height:auto;min-width:430px;display:block">${ticks.join("")}${paths}${xl}</svg>`;
}
function renderDashTable(per) {
  if (!per.length) { $("dashTbody").innerHTML = '<tr><td colspan="6" class="placeholder">暂无账号</td></tr>'; $("dashMeta").textContent = ""; return; }
  const rows = per.map((a, i) => `<tr>
    <td class="num" style="color:var(--faint)">${i + 1}</td>
    <td>${acctName(a)}</td>
    <td class="num"><b>${a.currentRemain ?? "-"}</b></td>
    <td class="num">${a.used ?? "-"}</td>
    <td class="num">${a.points > 1 ? (a.consumed > 0 ? fmt(a.consumed) : "0") : "—"}</td>
    <td class="num" style="color:var(--faint)">${a.points}</td>
  </tr>`).join("");
  const sum = (k) => per.reduce((s, x) => s + (x[k] || 0), 0);
  $("dashTbody").innerHTML = rows + `<tr style="border-top:2px solid var(--line-strong);font-weight:800">
    <td></td><td>合计</td><td class="num">${fmt(sum("currentRemain"))}</td><td class="num">${fmt(sum("used"))}</td>
    <td class="num">${fmt(sum("consumed"))}</td><td class="num" style="color:var(--faint)">${per.length} 账号</td></tr>`;
  $("dashMeta").textContent = per.length + " 个账号";
}
function renderDashLines() {
  const withSeries = DASH_PER.map((a) => ({ ...a, series: aggregateSeries(a.series || [], dashMode) })).filter((a) => a.series.length >= 2);
  if (!withSeries.length) {
    $("legend").innerHTML = "";
    $("chart").innerHTML = '<div class="placeholder">暂无足够数据,多刷新几次后出现折线(需 ≥2 个时间点)</div>';
    return;
  }
  $("legend").innerHTML = withSeries.map((a, i) => {
    const c = LINE_COLORS[i % LINE_COLORS.length];
    return `<div class="lg-item" data-key="${a.uin}" onclick="toggleLine('${a.uin}', this)"><span class="lg-dot" style="background:${c}"></span>${acctName(a)}</div>`;
  }).join("");
  $("chart").innerHTML = lineChartMulti(withSeries.map((a, i) => ({ key: a.uin, pts: a.series.map((x) => ({ t: x.t, v: x.v })) })));
}
function toggleLine(key, el) {
  const p = document.getElementById("line-" + key);
  if (!p) return;
  const hid = p.style.display === "none";
  p.style.display = hid ? "" : "none";
  if (el) el.classList.toggle("off", !hid);
}
function changeMode() { dashMode = $("dashLineMode").value; renderDashLines(); }
async function renderDashboards() {
  try {
    const j = await (await fetch("/api/dashboard/all")).json();
    if (!j.ok) return;
    DASH_PER = j.per || [];
    renderDashTable(DASH_PER);
    renderDashLines();
  } catch {}
}

// ---------------- 明细弹窗 ----------------
function closeDetail() { $("detailMask").classList.remove("show"); }
function openDetail(idx) {
  const r = ALL.results[idx];
  if (!r.summary || !r.data) return toast("该账号查询失败,无法查看明细");
  $("detailMask").classList.add("show");
  $("detailTitle").textContent = acctName(r.account) + " · 明细";
  const d = r.data, s = r.summary;
  const gifts = d.Accounts.filter((a) => !a.PackageName.includes("体验版"));
  const act = gifts.filter((a) => a.Status === 0).sort((a, b) => (a.CycleEndTime < b.CycleEndTime ? -1 : 1));
  const expC = gifts.filter((a) => a.Status !== 0).length;
  const baseNote = s.baseCycleEnd ? `(当月有效 · 至 ${s.baseCycleEnd.slice(5, 10)})` : "";
  $("detailBody").innerHTML = `
    <div style="font-size:11px;color:var(--faint);margin-bottom:12px">数据时间: ${ALL.fetchedAt}(点「刷新全部」获取最新)</div>
    <div class="mini-cards">
      <div class="mcard"><div class="l">体验版剩余 ${baseNote}</div><div class="v">${s.baseRemain ?? "-"}</div></div>
      <div class="mcard"><div class="l">赠送包已用/总量</div><div class="v">${fmt(s.giftUsed)} / ${s.giftSize}</div></div>
      <div class="mcard"><div class="l">赠送剩余</div><div class="v">${s.giftRemain}</div></div>
      <div class="mcard"><div class="l">剩余总积分</div><div class="v">${fmt(totalOf(s))}</div><div class="s">体验版 ${s.baseRemain ?? 0} + 赠送 ${s.giftRemain} · 过期 ${expC}</div></div>
    </div>
    <div class="sect"><div class="sect-title">📊 每周可用积分 <span class="sub">从今天起每 7 天</span></div>${renderWeekbars(act)}</div>
    <div class="sect"><div class="sect-title">📅 积分到期明细 <span class="sub">点击展开每天</span></div>${renderBuckets(act)}</div>
    <div class="sect"><div class="sect-title">📈 消耗历史 <span class="sub">赠送剩余变化</span></div><div id="histBox"><div class="placeholder" style="padding:16px">加载中…</div></div></div>`;
  loadHistoryTable(r.account.uin);
}
// 7 天分桶
function buildBuckets(gifts) {
  const t0 = new Date(); t0.setHours(0, 0, 0, 0);
  const buckets = []; let cur = null;
  for (const g of gifts) {
    const dt = new Date((g.CycleEndTime || "").replace(" ", "T"));
    const day = new Date(dt.getFullYear(), dt.getMonth(), dt.getDate());
    const diff = Math.max(0, Math.floor((day - t0) / 86400000));
    const bi = Math.floor(diff / 7);
    if (!cur || cur.idx !== bi) {
      cur = { idx: bi, start: new Date(t0.getTime() + bi * 7 * 86400000), end: new Date(t0.getTime() + (bi * 7 + 6) * 86400000), total: 0, count: 0, days: new Map() };
      buckets.push(cur);
    }
    cur.total += g.CapacityRemain; cur.count++;
    const dk = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`;
    if (!cur.days.has(dk)) cur.days.set(dk, []);
    cur.days.get(dk).push(g);
  }
  return buckets;
}
const fmtD = (d) => `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
function renderWeekbars(gifts) {
  const bks = buildBuckets(gifts);
  if (!bks.length) return '<div class="placeholder" style="padding:16px">无有效赠送包</div>';
  const max = Math.max(...bks.map((b) => b.total), 1);
  return `<div class="weekbars">${bks.map((b, i) => `<div class="wcol ${i === 0 ? "now" : ""}">
    <div class="wv">${fmt(b.total)}</div>
    <div class="wtrack"><div class="wfill" style="height:${Math.max(4, b.total / max * 100)}%"></div></div>
    <div class="wr">${fmtD(b.start)}~${fmtD(b.end)}</div><div class="wc">${b.count} 包</div>
  </div>`).join("")}</div>`;
}
function renderBuckets(gifts) {
  const bks = buildBuckets(gifts);
  if (!bks.length) return "";
  return bks.map((b, i) => `<div class="bucket ${i === 0 ? "now" : ""}">
    <div class="bucket-h" onclick="this.parentElement.classList.toggle('open');const t=this.querySelector('.bt');t.textContent=t.textContent.includes('▸')?'▾ 收起':'▸ 查看每天'">
      <span class="br">${fmtD(b.start)} ~ ${fmtD(b.end)}</span>
      <span class="bs"><b>${fmt(b.total)}</b> 积分 · ${b.count} 包</span>
      <span class="bt">▸ 查看每天</span>
    </div>
    <div class="bdays">${[...b.days.entries()].sort().map(([dk, items]) => {
      const ds = items.reduce((s, x) => s + x.CapacityRemain, 0);
      return `<div class="bday"><div class="bday-h">${dk} · ${items.length} 包 · 剩余 ${fmt(ds)}</div>${items.map((x) => `<div class="bday-i">${shortName(x.PackageName)} ${fmt(x.CapacityUsed)}/${x.CapacitySize} · 剩余 ${x.CapacityRemain} · 到期 ${(x.CycleEndTime || "").slice(0, 16)}</div>`).join("")}</div>`;
    }).join("")}</div>
  </div>`).join("");
}
async function loadHistoryTable(uin) {
  try {
    const j = await (await fetch("/api/history?account=" + encodeURIComponent(uin))).json();
    const box = $("histBox");
    if (!box) return;
    if (!j.ok || !j.history || !j.history.length) { box.innerHTML = '<div class="placeholder" style="padding:14px">暂无历史(每次成功刷新自动记录)</div>'; return; }
    const h = j.history;
    let prev = null;
    const rows = h.map((x) => {
      const dt = x.ts.slice(0, 16).replace("T", " ");
      const diff = prev === null ? null : x.totalRemain - prev;
      const t = diff === null ? "—" : diff < 0 ? `<span class="badge bad">-${Math.abs(diff)}</span>` : `<span class="badge ok">0</span>`;
      prev = x.totalRemain;
      return `<tr><td class="num" style="color:var(--faint)">${dt}</td><td class="num"><b>${fmt(x.totalRemain)}</b></td><td>${t}</td></tr>`;
    }).reverse().join("");
    box.innerHTML = `<div class="tbl" style="max-height:240px"><table style="min-width:0">
      <thead><tr><th>时间</th><th>剩余总积分</th><th>较上次</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  } catch {
    const box = $("histBox");
    if (box) box.innerHTML = '<div class="placeholder" style="padding:14px">历史加载失败</div>';
  }
}

// ---------------- 初始化 ----------------
async function init() {
  // 演示模式:自包含 HTML 内嵌 __DEMO__ 快照时,直接用快照渲染(离线可看)
  if (window.__DEMO__) {
    ALL = window.__DEMO__.all;
    DASH_PER = window.__DEMO__.dash || [];
    $("updated").textContent = "演示数据 · " + ALL.fetchedAt + "(自包含文件,双击即可查看)";
    renderAll();
    renderDashboards();
    applyAuto();
    return;
  }
  await loadCache();
  refreshAll(false);
  renderDashboards();
  checkDaemon();
  applyAuto();
}
init();
