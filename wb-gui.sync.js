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
    if (j.has) { setSyncStatus("已保存配置,点「🔄 一键同步」拉取合并并上传(如需改配置点「保存并测试」)"); showSyncQuick(); }
    else setSyncStatus("尚未配置,填写后点「保存并测试」");
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
  setSyncStatus(
    action === "test" ? "测试中…" :
    action === "sync" ? "同步中(拉取合并+上传)…" :
    action === "clear" ? "清空中…" : "下载中…"
  );
  try {
    // 一键同步为无损合并(双向取最新+墓碑删除传播),无需删除确认;download 保留旧接口兼容
    if (action === "download" && !await cfm("下载会覆盖本地的账号池/历史数据,确定继续吗?")) { setSyncStatus("已取消"); return; }
    if (action === "clear" && !await cfm("确认清空本地保存的 WebDAV 登录配置?")) { setSyncStatus("已取消"); return; }
    const j = await api(__BASE__ + "/api/webdav/" + action, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}) });
    if (action === "test" || action === "sync") { showSyncQuick(); } // 连通/同步成功 → 操作条出现 🔄 快捷同步
    if (action === "clear") {
      const q = $("syncQuick"); if (q) q.hidden = true; closeSync();
      autoUpOn = false; localStorage.setItem(LS_UP_ON, "0"); applyAutoUp(); // 配置已清空,联动关闭自动同步
    }
    if (!silent) toast("✅ " + j.message);
    setSyncStatus("✅ " + j.message + (action === "sync" && j.first ? "(首次同步,远端已有备份)" : ""));
    if (action === "sync" || (action === "download" && j.restored && j.restored.length)) refreshAll(false);
  } catch (e) {
    toast("❌ " + e.message); // 失败总是提示(silent 只静默成功;自动同步失败必须可见)
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

// ---- 自动同步(WebDAV,登录后可用;v1.4.46 由"自动上传"升级) ----
// 与「页面自动刷新」同构:前端定时触发同步(先拉合并进本地,再上传全量;静默成功、失败必报,
// 复用 syncAct("sync") 单一路径)。间隔单位=小时(默认 12),localStorage 持久化,exe/GUI 常驻时到点自动备份。
async function autoSync() {
  if (syncBusy) return; // 与手动同步互斥
  // 配置被清空后自动关闭开关,避免周期性失败骚扰
  try {
    const c = await api(__BASE__ + "/api/webdav/config");
    if (!c.has) {
      autoUpOn = false;
      localStorage.setItem(LS_UP_ON, "0");
      applyAutoUp();
      toast("⚠️ 未配置 WebDAV,自动同步已自动关闭");
      return;
    }
  } catch { return; }
  await syncAct("sync", true);
}
function applyAutoUp() {
  clearInterval(autoUpTimer); autoUpTimer = null;
  const c = $("autoUpOnChk"); if (c) c.checked = autoUpOn;
  const inp = $("autoUpH"); if (inp) inp.value = autoUpH;
  if (autoUpOn && autoUpH > 0) {
    autoUpTimer = setInterval(() => autoSync(), autoUpH * 3600 * 1000);
  }
}
function toggleAutoUp() {
  autoUpOn = !autoUpOn;
  localStorage.setItem(LS_UP_ON, autoUpOn ? "1" : "0");
  applyAutoUp();
  toast(autoUpOn ? `自动同步:每 ${autoUpH} 小时` : "自动同步已关闭");
}
