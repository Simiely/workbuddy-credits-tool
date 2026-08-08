// wb-gui.render.js — 渲染层（hero/卡片/仪表盘表格/到期柱图）（wb-gui 拆分第 3 部分）
// 依赖 wb-gui.state.js（状态/常量/helper）与 wb-gui.core.js（api/toast 等）。
// 本层只负责把数据画到 DOM；所有数据来自单一 model：账号对象 r 上的 r.derived（由 doRefresh 合并）
// 与 dashPer（表格视图）。render*/renderDash 都是纯函数，自身不发起任何网络请求。
// 趋势柱状图/窗口/图例/模式切换已拆分到 wb-gui.chart.js（加载顺序 render.js → chart.js → ops.js）。

// 数据指纹:刷新时比较,未变则跳过卡片/hero 重绘(自动刷新不再整页闪屏/抖动)
// 派生字段(expiring3d/todayUsed/alerts)也纳入指纹 → 仪表盘派生就绪后卡片会自动重绘
function fpS() {
  const rs = (S && S.results) || [];
  return rs.map((r) => {
    const s = r.summary, d = r.derived || {};
    return (r.account.id || "") + "|" + (s ? [s.baseRemain, s.giftRemain, s.baseUsed, s.giftUsed, s.giftCount].join(",") : "f") + "|"
      + "|d" + (d.expiring3d || 0) + "|" + (d.todayUsed || 0) + "|" + ((d.dailyUsed || []).length);
  }).join(";");
}

function render() {
  // S 未变 → hero/卡片不重绘(重绘会闪屏、重绑拖拽;节点保留则事件与滚动位置都在)
  const sfp = fpS();
  if (sfp !== lastSfp) {
    renderHero();
    renderCards();
    lastSfp = sfp;
  }
  renderDash(); // 表格/折线(读 dashPer,纯渲染)
}

function renderHero() {
  const rs = (S && S.results) || [];
  const okN = rs.filter((r) => r.summary).length;
  const failN = rs.length - okN;
  const total = rs.reduce((s, r) => s + (r.summary ? totalOf(r.summary) : 0), 0);
  const used = rs.reduce((s, r) => s + (((r.derived || {}).consumed) || 0), 0); // 累计已用=历史每日消耗之和(derived.consumed)
  // 近3天过期 / 今日已用：直接消费账号对象上的 derived（单一来源，不再 patch dashPer 到 hero）
  const exp3d = rs.reduce((s, r) => s + (((r.derived || {}).expiring3d) || 0), 0);
  const totalUsed = rs.reduce((s, r) => s + (((r.derived || {}).todayUsed) || 0), 0);
  // 昨日已用(自然日):从 dailyUsed 取昨天的消耗作对比基准;昨天无记录则只显示数值不显示箭头
  const yest = new Date(); yest.setDate(yest.getDate() - 1);
  const yestK = `${yest.getFullYear()}-${String(yest.getMonth() + 1).padStart(2, "0")}-${String(yest.getDate()).padStart(2, "0")}`;
  let yestUsed = 0, yestHas = false;
  for (const r of rs) {
    const dl = ((r.derived || {}).dailyUsed) || [];
    const y = dl.find((x) => x.day === yestK);
    if (y) { yestUsed += y.used || 0; yestHas = true; }
  }
  let cls = "ok", sub = "✅ 一切正常";
  if (!rs.length) { cls = ""; sub = "账号池为空,点「＋ 添加当前账号」"; }
  else if (failN > 0) { cls = "warn"; sub = `${failN} 个账号查询失败`; }
  else sub = `✅ 一切正常 · ${okN}/${rs.length} 账号有效`;
  // 今日已用环比昨日(自然日):↑=今天比昨天用得多,↓=用得少
  let trendHtml = totalUsed > 0 ? fmt(totalUsed) : "0";
  if (yestHas) {
    const delta = totalUsed - yestUsed;
    const arrow = delta > 0 ? "↑" : "↓";
    const c = delta > 0 ? "var(--bad)" : "var(--ok)";
    trendHtml = `${fmt(totalUsed)} <span style="font-size:12px;color:${c}" title="较昨日${delta >= 0 ? "多" : "少"}用 ${fmt(Math.abs(delta))}">${arrow}${fmt(Math.abs(delta))}</span>`;
  }
  $("hero").innerHTML = `
    <div class="hcard total ${cls}"><span class="h-ico">🏦</span><div class="n" id="heroTotal">${rs.length ? fmt(total) : "—"}</div><div class="l">总剩余积分</div><div class="s">${sub}</div></div>
    <div class="hcard"><span class="h-ico">⏳</span><div class="n" id="heroExp3d">${rs.length ? fmt(exp3d) : "—"}</div><div class="l">近3天过期</div></div>
    <div class="hcard"><span class="h-ico">📉</span><div class="n" id="heroToday">${trendHtml}</div><div class="l">今日已用</div></div>
    <div class="hcard"><span class="h-ico">🔥</span><div class="n">${fmt(used)}</div><div class="l">累计已用</div></div>`;
}

// ---------- 过期统计（已收口到后端 derive.js 单派生源） ----------
// 前端不再从 r.data.Accounts 现算到期，全部消费 dashPer 的 expiring1d/expiring3d/giftBuckets/expiryTier。

// 各账号今日消耗/告警直接读 r.derived（由 dashboard/all 合并），不再维护独立 map。

function renderCards() {
  const rs = (S && S.results) || [];
  if (!rs.length) {
    $("grid").innerHTML = '<div class="empty"><div class="big">📭</div>账号池为空<br>点「＋ 添加当前账号」或命令行 wb-credits.bat save-current</div>';
    $("foot").textContent = "v1.4.49 · 数据来自 WorkBuddy 网页版接口 · 暂无账号数据(可「添加当前账号」或从 WebDAV 下载)";
    return;
  }
  $("grid").innerHTML = rs.map((r, i) => {
    const a = r.account, s = r.summary;
    const nm = escAttr(acctName(a)); // 显示名可自定义,必须转义后进 innerHTML(v1.4.49)
    // 改名/删除:与「今日消耗」同一行,靠右
    const acts = `<span class="acts" style="margin-left:auto"><button class="btn btn-d" onclick="event.stopPropagation();openRename('${a.id}')">改名</button>
      <button class="btn btn-d" onclick="event.stopPropagation();openDel('${a.id}')">删除</button></span>`;
    if (!s) {
      return `<div class="acct" data-id="${a.id}" draggable="true" onclick="openDetail('${a.id}')"><div class="acct-top">
        <div><div class="acct-name">${nm}</div><div class="acct-uin">Uin: ${a.uin || "?"}</div></div>
        <span class="remain" style="color:var(--bad);border-color:currentColor;background:transparent">❌ 查询失败</span></div>
        <div class="acct-rows"><div class="arow act-row"><div class="l">${escAttr(r.error || "查询失败")}</div>${acts}</div></div></div>`;
    }
    const bp = s.baseSize ? Math.min(100, (s.baseUsed / s.baseSize) * 100) : 0;
    const gp = s.giftSize ? Math.min(100, (s.giftUsed / s.giftSize) * 100) : 0;
    const baseNote = s.baseCycleEnd ? `(至 ${s.baseCycleEnd.slice(5, 10)})` : "";
    // 签到标记（v1.4.44）：由后端 derive 检测今日首条 vs 最新快照的新增满额包推断，见 detectSignIn
    const signed = (r.derived && r.derived.signedInToday)
      ? `<span class="signed" title="今日已签到">✅ 已签到</span>`
      : `<span class="signed no" title="今日未签到">⏰ 未签到</span>`;
    return `<div class="acct" data-id="${a.id}" data-uin="${a.uin}" draggable="true" onclick="openDetail('${a.id}')"><div class="acct-top">
      <div><div class="acct-name">${nm}</div><div class="acct-uin">Uin: ${a.uin || "?"}</div></div>
      <div class="remain"><span class="tt">💎 总剩余积分</span><span class="tn">${fmt(totalOf(s))}</span></div></div>
      <div class="acct-rows">
        <div class="arow"><div class="l"><span>🎁 体验版基础用量 ${baseNote}</span><b>剩余 ${s.baseRemain ?? "-"}</b></div>
          ${s.baseSize ? `<div class="meter ${bp > 85 ? "warn" : ""}"><i style="width:${bp}%"></i></div>` : ""}</div>
        <div class="arow"><div class="l"><span>📦 有效赠送包(${s.giftCount} 个)</span><b>剩余 ${s.giftRemain}</b></div>
          <div class="meter ${gp > 85 ? "warn" : ""}"><i style="width:${gp}%"></i></div></div>
        <div class="arow act-row"><div class="l t-brand"><div class="acct-today">今日消耗 ${fmt((r.derived && r.derived.todayUsed) || 0)}</div>${signed}</div>${acts}</div>
      </div></div>`;
  }).join("");
  initDrag();
  $("foot").textContent = "v1.4.49 · 数据来自 WorkBuddy 网页版接口 · 页面自动刷新 " + autoMin + " 分钟 · 查询失败可重新登录后「添加当前账号」 · 卡片可拖动排序";
}

// ---- 卡片拖拽排序(顺序随账号池持久化,经 /api/reorder 保存) ----
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

// renderDash 是纯渲染函数：只读 dashPer（S.results 的投影，已含凭证状态与派生指标），不发起网络请求。
// 数据获取与 derived 合并统一在 actions.js 的 doRefresh/mergeDerived 完成，避免多源竞态。
function renderDash() {
  renderDashTable();
  renderLines();
  if (dashPer.length) {
    const lastTs = dashPer.reduce((m, a) => {
      const pts = a.series || [];
      return pts.length ? Math.max(m, ...pts.map((p) => new Date(p.t).getTime())) : m;
    }, 0);
    if (lastTs) $("dashMeta").textContent = dashPer.length + " 个账号 · " + new Date(lastTs).toLocaleString("zh-CN").slice(5);
  }
}
function renderDashTable() {
  if (!dashPer.length) {
    $("dashCards").innerHTML = '<div class="ph ph-md">暂无账号</div>';
    $("dashTbody").innerHTML = '<tr><td colspan="8" class="ph">暂无账号</td></tr>';
    $("dashMeta").textContent = "";
    return;
  }
  // 单元格工具(卡片版)
  const cell = (label, val, color, bg, big) => `<div class="dcell ${bg}" ${color ? `style="--dc:var(--${color})"` : ""}>${big ? `<div class="dc-l">${label}</div><div class="dc-v big">${val}</div>` : `<div class="dc-l">${label}</div><div class="dc-v">${val}</div>`}</div>`;
  // 手机卡片版(桌面隐藏)
  const cards = dashPer.map((a, i) => {
    const tu = a.todayUsed || 0;
    const e2 = a.expiring2d || 0, e3 = a.expiring3d || 0, e7 = a.expiring7d || 0;
    return `<div class="dacct">
      <div class="dhead">
        <span class="di">${i + 1}</span>
        <span class="dname">${escAttr(acctName(a))}</span>
      </div>
      <div class="dremain"><div class="dr-v">${fmt(a.currentRemain ?? "-")}</div><div class="dr-l">💎 总剩余</div></div>
      <div class="dgrid">
        ${cell("今日消耗", fmt(tu), "", "plain", false)}
        ${cell("累计已用", fmt(a.consumed ?? "-"), "", "plain", false)}
        ${cell("近2天过期", fmt(e2), e2 > 0 ? "warn" : "", e2 > 0 ? "warn" : "ok", e2 > 0)}
        ${cell("近3天过期", fmt(e3), e3 > 0 ? "warn" : "", e3 > 0 ? "warn" : "ok", e3 > 0)}
        ${cell("近7天过期", fmt(e7), e7 > 0 ? "warn" : "", e7 > 0 ? "warn" : "ok", e7 > 0)}
      </div>
    </div>`;
  }).join("");
  const sum = (k) => dashPer.reduce((s, x) => s + (x[k] || 0), 0);
  const sumExp1d = dashPer.reduce((s, a) => s + (a.expiring1d || 0), 0);
  const sumExp2d = dashPer.reduce((s, a) => s + (a.expiring2d || 0), 0);
  const sumExp3d = dashPer.reduce((s, a) => s + (a.expiring3d || 0), 0);
  const sumExp7d = dashPer.reduce((s, a) => s + (a.expiring7d || 0), 0);
  const sumTu = dashPer.reduce((s, a) => s + (a.todayUsed || 0), 0);
  // 合计卡跨整行
  const total = `<div class="dacct dtot">
    <div class="dhead"><div class="dname num-b">📊 合计</div></div>
    <div class="dgrid">
      ${cell("今日消耗", fmt(sumTu), "", "plain", false)}
      ${cell("累计已用", fmt(sum("consumed")), "", "plain", false)}
      ${cell("近2天过期", fmt(sumExp2d), sumExp2d > 0 ? "warn" : "", sumExp2d > 0 ? "warn" : "ok", sumExp2d > 0)}
      ${cell("近3天过期", fmt(sumExp3d), sumExp3d > 0 ? "warn" : "", sumExp3d > 0 ? "warn" : "ok", sumExp3d > 0)}
      ${cell("近7天过期", fmt(sumExp7d), sumExp7d > 0 ? "warn" : "", sumExp7d > 0 ? "warn" : "ok", sumExp7d > 0)}
    </div>
    <div class="dremain" style="background:none;border:none;padding:6px 0 0"><div class="dr-v" style="font-size:22px;background:var(--grad);-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent">${fmt(sum("currentRemain"))}</div><div class="dr-l">💎 总剩余</div></div>
  </div>`;
  $("dashCards").innerHTML = cards + total;
  // ===== 桌面表格版(手机隐藏) =====
  const rows = dashPer.map((a, i) => {
    const e1 = a.expiring1d || 0, e2 = a.expiring2d || 0, e3 = a.expiring3d || 0, e7 = a.expiring7d || 0;
    return `<tr>
    <td class="num t-faint">${i + 1}</td><td>${escAttr(acctName(a))}</td>
    <td class="num"><b>${a.currentRemain ?? "-"}</b></td><td class="num">${a.consumed ?? "-"}</td>
    <td class="num">${a.todayUsed > 0 ? fmt(a.todayUsed) : "0"}</td>
    <td class="num" style="color:var(--${e1 > 0 ? 'warn' : 'faint'})">${fmt(e1)}</td>
    <td class="num" style="color:var(--${e2 > 0 ? 'warn' : 'faint'})${e2 > 0 ? ';font-weight:800' : ''}">${fmt(e2)}</td>
    <td class="num" style="color:var(--${e3 > 0 ? 'warn' : 'faint'})">${fmt(e3)}</td>
    <td class="num" style="color:var(--${e7 > 0 ? 'warn' : 'faint'})${e7 > 0 ? ';font-weight:800' : ''}">${fmt(e7)}</td></tr>`;
  }).join("");
  $("dashTbody").innerHTML = rows + `<tr class="row-total">
    <td></td><td>合计</td><td class="num">${fmt(sum("currentRemain"))}</td><td class="num">${fmt(sum("consumed"))}</td>
    <td class="num">${fmt(sumTu)}</td><td class="num">${fmt(sumExp1d)}</td><td class="num">${fmt(sumExp2d)}</td><td class="num">${fmt(sumExp3d)}</td><td class="num">${fmt(sumExp7d)}</td></tr>`;
}
// ===== 趋势图表（柱状图/每日窗口/图例交互/模式切换）已拆分到 wb-gui.chart.js =====

// 纯渲染:到期柱图(1天/3天到期 + 周桶),数据来自后端 derive.giftBuckets(已含 start/end MM-DD)
function renderGiftBuckets(buckets, e1, e3) {
  buckets = buckets || [];
  if (!buckets.length) return '<div class="sect"><div class="stitle">📅 积分到期明细 <span class="sub">从今天起</span></div><div class="ph ph-sm">无有效赠送包</div></div>';
  const max = Math.max(e1, e3, ...buckets.map((x) => x.total || 0), 1);
  const bar = (label, val, cls, note) => `<div class="bar-col"><div class="bar-v ${cls}">${fmt(val)}</div>
    <div class="bar-track"><div class="bar-fill ${cls}" style="height:${Math.max(4, (val / max) * 100)}%"></div></div>
    <div class="bar-label">${label}</div><div class="bar-sub">${note}</div></div>`;
  const bars = [
    bar("1天到期", e1, "bad", "今+明"),
    bar("3天到期", e3, "warn", "至3天后"),
    ...buckets.map((b, i) => bar(`${b.start}~${b.end}`, b.total, i === 0 ? "warn" : "brand", `${b.count} 包`)),
  ].join("");
  return `<div class="sect"><div class="stitle">📅 积分到期明细 <span class="sub">从今天起</span></div>
    <div class="bar-row">${bars}</div></div>`;
}
