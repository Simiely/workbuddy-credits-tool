// wb-gui.sync.js — WebDAV 云同步（拆分第 6 部分，v1.4.7 从 actions.js 拆出）
// 依赖：state(状态/helper)、core(api/toast/遮罩/cfm/SYNC_DEFAULT_URL)。
// 职责：WebDAV 配置弹窗 · 测试/上传/下载/清空云端 · 操作条快捷按钮。
// 与 actions.js 共享同一全局词法作用域，classic <script> 按 state→core→render→ops→sync→actions 顺序加载。

function setSyncStatus(msg) {
  const s = $("syncStatus");
  if (!s) return;
  s.textContent = msg;
  s.style.color = /✅|已|成功|覆盖/.test(msg) ? "var(--ok)" : /❌|失败|错误/.test(msg) ? "var(--bad)" : "var(--sub)";
}
function showSyncQuick() { const a = $("syncQuick"); if (a) a.hidden = false; } // 操作条:云同步右侧的上传/下载快捷按钮
async function openSync() {
  openMask("syncMask");
  setSyncStatus("加载配置…");
  try {
    const j = await api(__BASE__ + "/api/webdav/config");
    $("syncUrl").value = (j.url && j.url !== SYNC_DEFAULT_URL) ? j.url : "";
    $("syncUser").value = j.user || "";
    $("syncPass").value = "";
    $("syncPass").placeholder = j.has ? "留空则保留原密码" : "请输入 WebDAV 密码";
    if (j.has) { setSyncStatus("已保存配置,可直接上传/下载(如需改配置点「保存配置」)"); showSyncQuick(); }
    else setSyncStatus("尚未配置,填写后点「保存配置」");
  } catch (e) { setSyncStatus("❌ " + e.message); }
}
function closeSync() { closeMask("syncMask"); }
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
    if (action === "clear") { const q = $("syncQuick"); if (q) q.hidden = true; closeSync(); }
    if (!silent) toast("✅ " + j.message);
    setSyncStatus("✅ " + j.message + (action === "download" && j.restored && j.restored.length ? ",请点「刷新全部」查看" : ""));
    if (action === "download" && j.restored && j.restored.length) refreshAll(false);
  } catch (e) {
    if (!silent) toast("❌ " + e.message);
    setSyncStatus("❌ " + e.message);
  } finally { syncBusy = false; }
}

// 若已配置过 WebDAV,操作条云同步右侧直接显示上传/下载
async function checkWebdavQuick() {
  try {
    const j = await api(__BASE__ + "/api/webdav/config");
    if (j.has) showSyncQuick();
  } catch {}
}
