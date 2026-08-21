/** popup.js - 弹窗交互 */
const $ = (id) => document.getElementById(id);
const status = $("status");

function setStatus(html, cls) {
  status.innerHTML = html;
  status.className = cls || "";
}
function busy(on, btn) {
  if (btn) btn.disabled = on;
}

async function send(msg) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(msg, (r) => resolve(r));
  });
}

// HTML 转义,避免 uin/name 注入
function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

// 渲染「已抓取账号」展示区(读 chrome.storage 里的 CACHE_KEY)
function renderCaptured(info) {
  const box = $("captured");
  const body = $("capBody");
  let a, at, total, dosage;
  if (info && info.account) {
    a = info.account; at = info.capturedAt; total = info.total; dosage = info.dosage;
  } else if (info && info.rec) {
    a = info.rec; at = new Date().toISOString(); total = info.total; dosage = info.dosage;
  }
  if (!a) { box.classList.add("hidden"); return; }
  box.classList.remove("hidden");
  const ckLen = (a.cookieHeader || "").length;
  const exp = a.sessionExpiresAt ? new Date(a.sessionExpiresAt).toLocaleString() : "未知";
  body.innerHTML =
    `<div class="cap-row"><span>Uin</span><b>${esc(a.uin)}</b></div>` +
    `<div class="cap-row"><span>名称</span><b>${esc(a.name)}</b></div>` +
    `<div class="cap-row"><span>积分</span><b>${esc(total)} 包 / ${esc(dosage)} 分</b></div>` +
    `<div class="cap-row"><span>Cookie</span><b>${ckLen} 字节</b></div>` +
    `<div class="cap-row"><span>抓取时间</span><b>${new Date(at).toLocaleString()}</b></div>` +
    `<div class="cap-row"><span>会话过期</span><b>${exp}</b></div>`;
}

// 初始化:回填配置与最近抓取信息
(async function init() {
  const st = await send({ action: "getState" });
  if (st && st.ok) {
    if (st.config && st.config.url) $("cfgUrl").value = st.config.url;
    if (st.config && st.config.user) $("cfgUser").value = st.config.user;
    if (st.config && st.config.pass) $("cfgPass").value = st.config.pass;
    renderCaptured(st.cache);
  }
})();

// 打开 workbuddy.cn(便于登录 / 产生 cookie 后抓取)
$("btnOpen").onclick = () => {
  chrome.tabs.create({ url: "https://www.workbuddy.cn/", active: true });
};

$("btnCapture").onclick = async () => {
  busy(true, $("btnCapture"));
  setStatus("抓取中...");
  const r = await send({ action: "capture" });
  busy(false, $("btnCapture"));
  if (r && r.ok) {
    renderCaptured({ rec: r.rec, total: r.total, dosage: r.dosage });
    setStatus(
      `✅ 抓取成功\n账号: ${r.rec.uin}\n积分: ${r.total} 包 / ${r.dosage}\n\n点「抓取并同步 WebDAV」上传,或在仪表盘「一键同步」拉取。`,
      "ok"
    );
  } else {
    setStatus("❌ " + ((r && r.error) || "失败"), "err");
  }
};

$("btnSync").onclick = async () => {
  busy(true, $("btnSync"));
  setStatus("抓取并同步中...");
  const r = await send({ action: "sync" });
  busy(false, $("btnSync"));
  if (r && r.ok) {
    const st = await send({ action: "getState" });
    renderCaptured(st && st.cache);
    setStatus(
      `✅ 同步完成\n账号: ${r.merged}(共 ${r.totalAccounts} 个账号)\n已上传: ${r.url}\n\n现在去积分仪表盘点「☁️ 云同步 → 🔄 一键同步」即可导入。`,
      "ok"
    );
  } else {
    setStatus("❌ " + ((r && r.error) || "失败"), "err");
  }
};

// 导出文件:把当前抓取结果下载为 wb-accounts.json(标准格式),交给 WorkBuddy 直接灌入服务器
$("btnExport").onclick = async () => {
  busy(true, $("btnExport"));
  setStatus("导出中...");
  const r = await send({ action: "export" });
  busy(false, $("btnExport"));
  if (!r || !r.ok) {
    setStatus("❌ " + ((r && r.error) || "导出失败"), "err");
    return;
  }
  const blob = new Blob([r.json], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "wb-accounts.json";
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  setStatus(
    `✅ 已导出 wb-accounts.json\n账号: ${r.uin}\n\n把此文件发给 WorkBuddy(拖进对话或放到桌面),\n它会直接灌入积分仪表盘服务器,无需 WebDAV。`,
    "ok"
  );
};

// 删除当前抓取账号(清本地缓存;若已配 WebDAV 则同步移除云端并加墓碑)
$("btnDelete").onclick = async () => {
  if (!confirm("确定删除该抓取账号?\n本地缓存将清除;若已配置 WebDAV 也会从云端移除。\n(若已在积分仪表盘导入,需再到仪表盘删一次)")) return;
  busy(true, $("btnDelete"));
  setStatus("删除中...");
  const r = await send({ action: "deleteCapture" });
  busy(false, $("btnDelete"));
  if (r && r.ok) {
    renderCaptured(null);
    const w = r.webdav || {};
    let msg = `✅ 已删除抓取账号 ${r.uin}\n(本地缓存已清除`;
    if (w.removed) msg += `;云端 WebDAV 已移除并加墓碑)`;
    else if (w.error) msg += `;云端移除失败:${w.error},稍后重试或在服务器删)`;
    else msg += `;未配置 WebDAV)`;
    msg += `\n\n若已在积分仪表盘导入,请在那里也删一次。`;
    setStatus(msg, "ok");
  } else {
    setStatus("❌ " + ((r && r.error) || "删除失败"), "err");
  }
};

$("btnSave").onclick = async () => {
  const r = await send({
    action: "saveConfig",
    url: $("cfgUrl").value.trim(),
    user: $("cfgUser").value.trim(),
    pass: $("cfgPass").value,
  });
  setStatus(r && r.ok ? "✅ 配置已保存" : "❌ 保存失败", r && r.ok ? "ok" : "err");
};

$("btnTest").onclick = async () => {
  busy(true, $("btnTest"));
  setStatus("测试连接中...");
  const r = await send({ action: "test" });
  busy(false, $("btnTest"));
  if (r && r.ok) setStatus(`✅ WebDAV 连接成功\n目录: ${r.url}`, "ok");
  else setStatus("❌ " + ((r && r.error) || "失败"), "err");
};
