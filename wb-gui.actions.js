// wb-gui.actions.js — 生命周期 / 自动刷新(SSE) / 管理员状态 / 启动接线（拆分第 4 部分，须最后加载）
// 依赖 wb-gui.state.js（状态/helper）、wb-gui.core.js（api/遮罩/管理员）、wb-gui.render.js（render*）、
// wb-gui.ops.js（账号与数据操作）、wb-gui.sync.js（WebDAV 同步）。
// 职责：页面刷新编排(缓存秒开→实时覆盖) · 自动刷新策略(轮询/SSE/兜底) · 🔒 管理按钮状态 · 启动事件绑定。
// 本文件包含唯一会触发副作用的顶层语句（事件绑定 + 启动流程），放在最后加载，确保 DOM 已就绪、各函数已定义。

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
    const oldSfp = fpS(); // 基于旧 S 的指纹,用于判断本次是否有变化
    // 保留上一轮派生(今日已用/到期等),刷新瞬间先用旧值首屏,避免回落成 0;mergeDerived 会用新数据覆盖
    const prevDerived = new Map();
    for (const r of ((S && S.results) || [])) {
      const k = r.account && r.account.uin;
      if (k) prevDerived.set(k, r.derived || {});
    }
    const all = await api(__BASE__ + "/api/all", { timeout: 30000 });
    S = all;
    // 回填上一轮派生,使即时首屏显示上一次真实值而非 0
    for (const r of (S.results || [])) {
      const k = r.account && r.account.uin;
      if (k && prevDerived.has(k)) r.derived = prevDerived.get(k);
    }
    showErr("");
    // 先出卡片/hero(派生沿用上一轮,首屏即真实值;新数据到达后 mergeDerived 覆盖)
    renderCards();
    renderHero();
    $("updated").textContent = "更新于 " + all.fetchedAt;
    // 仪表盘派生(今日消耗/到期/折线)一次性取回,合并进账号对象,形成前端唯一数据源
    let dash = null;
    try { dash = await api(__BASE__ + "/api/dashboard/all"); } catch { dash = null; }
    dashPer = (dash && dash.per) || [];
    mergeDerived();
    render(); // 卡片/hero/表格/折线全部从单一 model 重渲染(派生已就绪)
    if (manual) {
      const rs = all.results || [];
      if (!rs.length) { toast("⚠️ 暂无账号数据(点「＋ 添加账号」或从 WebDAV 下载)"); }
      else {
        const ok = rs.filter((r) => r.summary).length;
        const changed = fpS() !== oldSfp;
        toast(changed ? `✅ 刷新成功(${ok}/${rs.length} 个账号)` : "✅ 已是最新数据(无变化)");
      }
    }
  } catch (e) {
    showErr("❌ " + e.message + (S && S.results ? "，已显示上次数据" : "，点击刷新重试"));
    if (S && S.results) render();
  } finally {
    setBusy(false);
  }
}

// 由 S.results 投影重建 dashPer(单一真相源的收口:派生在 r.derived,凭证状态在 r.account)。
// 表格/折线只读 dashPer,因此投影后自然与卡片同序同源。doRefresh 与 saveOrder(拖拽/排序)都调用它。
function rebuildDash() {
  dashPer = (S.results || []).map((r) => ({
    uin: r.account.uin,
    displayName: r.account.displayName || "",
    name: r.account.name || r.account.uin || "",
    ...(r.derived || {}),
  }));
}
// 将仪表盘派生(按 uin)合并到账号对象,形成前端唯一数据源:
// render*/openDetail/sortBy* 全部只读 r.derived,不再有第二套数据 patch 回卡片/hero。
// 收口双数组:合并后把 dashPer 重建为 S.results 的投影(派生字段已在 r.derived 内),
// 仪表盘表格/折线与卡片同序同源,不再可能和账号池错位或漏账号。
function mergeDerived() {
  const map = {};
  for (const a of (dashPer || [])) if (a.uin) map[a.uin] = a;
  for (const r of (S && S.results) || []) r.derived = map[r.account.uin] || {};
  rebuildDash(); // dashPer 跟随 S.results 顺序重建
}

// ---- 自动刷新 / 实时推送(SSE) ----
function setStreamStatus(ok) {
  streamOk = ok;
  const dot = $("streamDot");
  if (dot) {
    dot.className = "sdot " + (ok ? "on" : "off");
    dot.title = ok ? "实时推送已连接(新数据自动刷新)" : "实时推送断开(已降级为定时刷新)";
  }
}
// 建立 SSE 连接:服务端有新快照时主动推送 refresh 事件,前端静默刷新
function connectStream() {
  if (typeof EventSource === "undefined") { setStreamStatus(false); return; }
  try {
    es = new EventSource(__BASE__ + "/api/stream");
    es.addEventListener("open", () => { setStreamStatus(true); applyAuto(); });   // 连接成功 → 重新评估刷新策略
    es.addEventListener("refresh", () => { refreshAll(false); });                  // 收到新数据 → 静默刷新
    es.addEventListener("error", () => { setStreamStatus(false); applyAuto(); }); // 断线:浏览器自动重连 + 降级轮询
  } catch { setStreamStatus(false); }
}
// 刷新策略：poll=显式定时轮询，sse=靠 SSE 推送(零轮询)，fallback=无推送时兜底轮询
function pickStrategy() {
  if (autoOn && autoMin > 0) return "poll";
  if (streamOk) return "sse";
  return "fallback";
}
function applyAuto() {
  clearInterval(autoTimer); autoTimer = null;
  const btn = $("btnAuto"); if (btn) btn.textContent = autoOn ? "开" : "关";
  if ($("autoMin")) $("autoMin").value = autoMin;
  const strategy = pickStrategy();
  if (strategy === "poll") {
    autoTimer = setInterval(() => refreshAll(false), autoMin * 60000); // 用户显式开启定时
  } else if (strategy === "fallback") {
    autoTimer = setInterval(() => refreshAll(false), 5 * 60000);        // SSE 未连，兜底轮询
  }
  // strategy === "sse" → 不启轮询，靠服务端实时推送
}
function toggleAuto() {
  autoOn = !autoOn;
  localStorage.setItem(LS_ON, autoOn ? "1" : "0");
  applyAuto();
  toast(autoOn ? `自动刷新:每 ${autoMin} 分钟` : "自动刷新已关闭");
}

// 启动时询问服务端是否启用管理员密码,并据状态显示 🔒 按钮
async function checkAdminStatus() {
  try {
    const j = await api(__BASE__ + "/api/admin/status");
    adminEnabled = !!(j.ok && j.enabled);
    updateAdminBtn();
  } catch {}
}
// 据启用状态更新按钮文案/提示(始终可见:未启用时点击可设置密码,启用后点击输入当前密码即清除)
function updateAdminBtn() {
  const b = $("btnAdmin");
  if (!b) return;
  b.hidden = false;
  if (adminEnabled) { b.textContent = "🔒 管理"; b.title = "点击清除管理密码(危险操作需先验证一次密码)"; }
  else { b.textContent = "🔒 设置密码"; b.title = "点击设置管理密码(启用后危险操作需验证一次)"; }
}

// ==================== 启动 + 顶层事件绑定（须在所有函数定义之后） ====================
// 提示条「✕」:隐藏并记住,刷新后不再显示。用事件委托(无论 DOM 时序都可靠绑定)
document.addEventListener("click", (e) => {
  if (e.target && e.target.closest && e.target.closest("#daemonHide")) {
    $("daemonWarn").hidden = true;
    try { localStorage.setItem(LS_DAEMON_HIDE, "1"); } catch {}
  }
});
$("autoMin") && $("autoMin").addEventListener("change", () => {
  const v = parseInt($("autoMin").value, 10);
  if (!v || v < 1) { $("autoMin").value = autoMin; return; }
  autoMin = v > 1440 ? 1440 : v;
  localStorage.setItem(LS_MIN, String(autoMin));
  applyAuto();
  toast(`间隔已设为 ${autoMin} 分钟`);
});
$("renameInput") && $("renameInput").addEventListener("keydown", (e) => { if (e.key === "Enter") confirmSmall(); if (e.key === "Escape") closeSmall(); });
$("syncPass") && $("syncPass").addEventListener("keydown", (e) => { if (e.key === "Enter") saveSyncCfg(); });
$("adminPass") && $("adminPass").addEventListener("keydown", (e) => { if (e.key === "Enter") confirmAdmin(); if (e.key === "Escape") closeAdmin(); });

// 流程:先本地缓存秒开 → 后台实时刷新 → 其余初始化并行
applyFold(); // 恢复上次面板折叠状态(v1.4.34)
initChartTip(); // 图表悬浮提示事件委托(v1.4.38 归位 chart.js,启动接线)
refreshAll(false);
checkDaemon();
checkWebdavQuick();
checkAdminStatus(); // 是否需要管理员密码
applyAuto();
connectStream(); // 建立 SSE 实时推送(替代前端轮询)
