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

// 初始化:回填配置与最近状态
(async function init() {
  const st = await send({ action: "getState" });
  if (st && st.ok) {
    if (st.config && st.config.url) $("cfgUrl").value = st.config.url;
    if (st.config && st.config.user) $("cfgUser").value = st.config.user;
    if (st.config && st.config.pass) $("cfgPass").value = st.config.pass;
    if (st.cache && st.cache.account) {
      const a = st.cache.account;
      setStatus(
        `上次抓取: ${new Date(st.cache.capturedAt).toLocaleString()}\nUin: ${a.uin}\n剩余: ${st.cache.total} 包 / ${st.cache.dosage} 积分`,
        "ok"
      );
    }
  }
})();

$("btnCapture").onclick = async () => {
  busy(true, $("btnCapture"));
  setStatus("抓取中...");
  const r = await send({ action: "capture" });
  busy(false, $("btnCapture"));
  if (r && r.ok) {
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
    setStatus(
      `✅ 同步完成\n账号: ${r.merged}(共 ${r.totalAccounts} 个账号)\n已上传: ${r.url}\n\n现在去积分仪表盘点「☁️ 云同步 → 🔄 一键同步」即可导入。`,
      "ok"
    );
  } else {
    setStatus("❌ " + ((r && r.error) || "失败"), "err");
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
