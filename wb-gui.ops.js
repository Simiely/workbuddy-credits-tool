// wb-gui.ops.js — 账号与数据操作（拆分第 5 部分，v1.4.7 从 actions.js 拆出）
// 依赖：state(状态/helper)、core(api/toast/遮罩/管理员)、render(render*)、actions(refreshAll)。
// 职责：排序(拖拽/一键) · 明细弹窗 · 改名/删除 · 导入/导出 · 清空本地数据。
// 与 actions.js 共享同一全局词法作用域，classic <script> 按 state→core→render→ops→sync→actions 顺序加载。

// ---- 保存排序:POST /api/reorder + 同步数据 + 重渲染 + 成功/失败提示(拖拽/一键排序共用) ----
async function saveOrder(ids, okMsg) {
  try {
    await api(__BASE__ + "/api/reorder", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ids }) });
    const byId = new Map((S.results || []).map((r) => [r.account.id, r]));
    S.results = ids.map((id) => byId.get(id)).filter(Boolean);
    renderCards();  // 卡片按新序重绘(绕过指纹)
    rebuildDash();   // dashPer 跟随 S.results 顺序重建
    renderDash();    // 表格/折线按新序重绘(与卡片一致)
    toast("✅ " + okMsg);
  } catch (e) {
    toast("❌ " + e.message);
    refreshAll(false); // 失败回滚到服务端顺序
  }
}
async function moveCard(fromId, toId) {
  const cards = [...$("grid").querySelectorAll(".acct")];
  const from = cards.find((c) => c.dataset.id === fromId);
  const to = cards.find((c) => c.dataset.id === toId);
  if (!from || !to) return;
  if (from.compareDocumentPosition(to) & Node.DOCUMENT_POSITION_FOLLOWING) to.after(from);
  else to.before(from);
  const ids = [...$("grid").querySelectorAll(".acct")].map((c) => c.dataset.id);
  await saveOrder(ids, "卡片顺序已保存");
}

// ---- 一键排序:按指定指标从多到少(保存到账号池,与拖拽同机制) ----
// 保存排序结果 + 渲染 + 提示(排序与保存共用)
async function persistOrder(sorted, label) {
  S.results = sorted;
  renderCards();
  const ids = S.results.map((r) => r.account.id);
  await saveOrder(ids, `已按${label}从多到少排序并保存`);
}
async function sortByMetric(getV, label) {
  const rs = (S && S.results) || [];
  if (rs.length < 2) return toast("账号不足 2 个,无需排序");
  const sorted = [...rs].sort((a, b) => (getV(b) || 0) - (getV(a) || 0)); // 无值(失败/过期)视为 0,自然排最后
  await persistOrder(sorted, label);
}
function sortByTotal() { sortByMetric((r) => totalOf(r.summary), "总剩余"); }
// 使用排序:按今日已用从多到少(读 r.derived.todayUsed,mergeDerived 后可用)
function sortByTodayUsed() { sortByMetric((r) => ((r.derived || {}).todayUsed) || 0, "使用"); }
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

// ---- 明细弹窗 ----
function openDetail(id) {
  if (suppressClick) return; // 拖拽后抑制误触点击
  const r = (S && S.results || []).find((x) => x.account.id === id); // 用 id 定位,拖拽后不串位
  if (!r || !r.summary) return toast("该账号暂无数据,无法查看明细");
  const d = derivedOf(r) || {}; // 赠送包到期/汇总全部来自后端派生(dashPer),前端不再现算
  openMask("mask");
  $("mTitle").textContent = escAttr(acctName(r.account)) + " · 明细";
  const baseNote = d.baseCycleEnd ? `(当月有效 · 至 ${String(d.baseCycleEnd).slice(5, 10)})` : "";
  const baseRemain = d.baseRemain ?? "-";
  const giftRemain = d.giftRemain ?? 0;
  const expC = d.expCount ?? 0;
  const totalRemain = (d.baseRemain ?? 0) + (d.giftRemain ?? 0);
  $("mBody").innerHTML = `
    <div class="hint hint-mb">数据时间: ${(S && S.fetchedAt) || "-"} · 点「刷新全部」获取最新</div>
    <div class="cards">
      <div class="mcard"><div class="l">🎁 体验版剩余 ${baseNote}</div><div class="v">${baseRemain}</div></div>
      <div class="mcard"><div class="l">📦 赠送包已用/总量</div><div class="v">${fmt(d.giftUsed ?? 0)} / ${d.giftSize ?? "-"}</div></div>
      <div class="mcard"><div class="l">💝 赠送剩余</div><div class="v">${giftRemain}</div></div>
      <div class="mcard"><div class="l">💎 剩余总积分</div><div class="v">${fmt(totalRemain)}</div><div class="s">体验版 ${baseRemain} + 赠送 ${giftRemain} · 过期 ${expC}</div></div>
    </div>
    ${renderGiftBuckets(d.giftBuckets, d.expiring1d || 0, d.expiring3d || 0)}
    <div class="sect"><div class="stitle">📈 消耗历史 <span class="sub">剩余总积分变化</span></div><div id="histBox"><div class="ph ph-sm">加载中…</div></div></div>`;
  loadHist(r.account.uin);
}
async function loadHist(uin) {
  try {
    // 消费后端派生视图(P3):日消耗/起止剩余已由 deriveAccount 算好,前端不再按日聚合重算
    const j = await api(__BASE__ + "/api/derived?account=" + encodeURIComponent(uin));
    const d = j.derived || {};
    const days = (d.dailyUsed || []).slice().sort((a, b) => b.day.localeCompare(a.day)); // 日期降序(最近在前)
    const box = $("histBox");
    if (!box) return;
    if (!days.length) { box.innerHTML = '<div class="ph ph-sm">暂无历史(每次成功刷新自动记录)</div>'; return; }
    const rows = days.map((x) => {
      const diff = x.used > 0 ? `<span class="t-bad num-b">-${fmt(x.used)}</span>` : x.used === 0 ? "0" : `<span class="t-ok">+${fmt(Math.abs(x.used))}</span>`;
      return `<tr><td class="num t-faint">${x.day}</td><td class="num">${fmt(x.startRemain)}</td><td class="num"><b>${fmt(x.endRemain)}</b></td><td>${diff}</td></tr>`;
    }).join("");
    box.innerHTML = `<div class="tbl tbl-short"><table class="tbl-narrow"><thead><tr><th>日期</th><th>起</th><th>终</th><th>日消耗</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  } catch {
    const box = $("histBox");
    if (box) box.innerHTML = '<div class="ph ph-sm">历史加载失败</div>';
  }
}

// ---- 改名 / 删除 ----
function openRename(id) {
  small = { type: "rename", id };
  const r = (S.results || []).find((x) => x.account.id === id);
  openSmall("修改显示名称", `<div class="tip">显示名称仅用于界面展示,不影响底层账号。</div>
    <input class="finput" id="renameInput" maxlength="30" value="${escAttr((r && (r.account.displayName || r.account.name)) || "")}">
    <div class="factions"><button class="btn btn-g" onclick="closeSmall()">取消</button><button class="btn btn-p" onclick="confirmSmall()">保存</button></div>`);
  setTimeout(() => { const i = $("renameInput"); if (i) { i.focus(); i.select(); } }, 60);
}
function openDel(id) {
  small = { type: "del", id };
  const r = (S.results || []).find((x) => x.account.id === id);
  openSmall("删除账号", `<div class="tip">确认删除账号[${r ? acctName(r.account) : ""}]?不可恢复,需重新登录找回。</div>
    <div class="factions"><button class="btn btn-g" onclick="closeSmall()">取消</button><button class="btn btn-d btn-lg" onclick="confirmSmall()">删除</button></div>`);
}
async function confirmSmall() {
  if (!small) return;
  const { type, id } = small;
  small = null;
  closeSmall(); // 先关掉确认窗:后续若有密码验证窗,必须出现在最前(此前在 await api 后才关,密码窗被确认窗挡住)
  try {
    if (type === "rename") {
      const name = $("renameInput").value.trim();
      await api(__BASE__ + "/api/rename", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key: id, name }) });
      toast("已更新显示名称");
    } else {
      await api(__BASE__ + "/api/del", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key: id }) });
      toast("已删除");
    }
    refreshAll(false);
  } catch (e) { toast("❌ " + e.message); }
}

// ---- 导入账号信息 / 导出 ----
// 选择 Edge 插件导出的 wb-accounts.json,POST /api/import-json(smart 合并进 SQLite)
function importAccountsFromFile(input) {
  const f = input.files && input.files[0];
  if (!f) return;
  const reader = new FileReader();
  reader.onload = async () => {
    try {
      const data = JSON.parse(reader.result);
      const r = await api(__BASE__ + "/api/import-json", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      toast(`✅ 已导入账号信息:共 ${r.total} 个账号`);
      refreshAll(false);
    } catch (e) { toast("❌ " + e.message); }
    input.value = "";
  };
  reader.onerror = () => { toast("❌ 读取文件失败"); input.value = ""; };
  reader.readAsText(f);
}
function exportMd() { window.location.href = __BASE__ + "/api/export.md"; }

// 文件选择 change 绑定(脚本加载完成时执行)
(function bindImport() {
  const imp = $("importFile");
  if (imp) imp.addEventListener("change", (e) => importAccountsFromFile(e.target));
})();

// ---- 清空本地数据 ----
function openClear() { openMask("clearMask"); }
function closeClear() { closeMask("clearMask"); }
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
