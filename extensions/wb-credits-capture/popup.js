/** popup.js - 弹窗交互(多账号卡片) */
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

// 渲染账号卡片列表(每账号一张卡片,常显可编辑备注 + 删除;无内联事件,规避 MV3 CSP)
function renderCards(accounts) {
  const wrap = $("cards");
  const empty = $("cardsEmpty");
  const list = Array.isArray(accounts) ? accounts : [];
  empty.textContent = list.length ? `${list.length} 个账号` : "尚未抓取";
  if (!list.length) { wrap.innerHTML = ""; return; }

  wrap.innerHTML = list.map((a) => {
    // 只有真实备注才预填输入框;默认名"账号XXXX"仅作显示,不算备注(re-emphasis:空着保存即还原默认,不会误存成备注)
    const hasRemark = a.remarkSet === true && (a.name || "").trim() && !/^账号[0-9]{4,}$/.test(a.name || "");
    const remarkPrefill = hasRemark ? esc(a.name) : "";
    const label = hasRemark ? esc(a.name) : "（没有备注名）";
    return `
    <div class="card" data-uin="${esc(a.uin)}">
      <div class="row" style="align-items:center;">
        <div style="flex:1;min-width:0;">
          <div class="card-name" style="color:#ffb3b3;font-weight:700;font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${label}</div>
          <div class="card-uin">Uin: ${esc(a.uin)}</div>
        </div>
        <input class="remark-edit" data-uin="${esc(a.uin)}" value="${remarkPrefill}" placeholder="备注" style="width:88px;">
        <button class="save-remark secondary" data-uin="${esc(a.uin)}">保存</button>
      </div>
      <div class="row" style="margin:0;justify-content:flex-end;">
        <button class="delete-card danger" style="padding:3px 8px;font-size:11px" data-uin="${esc(a.uin)}">🗑 删除</button>
      </div>
    </div>`;
  }).join("");
}

// 事件委托:卡片内 保存备注 / 删除
$("cards").addEventListener("click", async (ev) => {
  const saveBtn = ev.target.closest(".save-remark");
  const delBtn = ev.target.closest(".delete-card");
  if (saveBtn) {
    const uin = saveBtn.dataset.uin;
    const remarkInput = document.querySelector(`.remark-edit[data-uin="${uin}"]`);
    const remark = (remarkInput && remarkInput.value || "").trim();
    busy(true, saveBtn);
    setStatus("保存备注中...");
    const r = await send({ action: "setRemark", uin, remark });
    busy(false, saveBtn);
    if (r && r.ok) {
      const st = await send({ action: "getState" });
      renderCards(st && st.accounts);
      setStatus(`✅ 已保存备注: [${r.name}]\n\n点「同步全部到 WebDAV」上传,云端该账号将采用此备注。`, "ok");
    } else {
      setStatus("❌ " + ((r && r.error) || "保存失败"), "err");
    }
    return;
  }
  if (delBtn) {
    const uin = delBtn.dataset.uin;
    if (!confirm("确定删除该账号?\n本地卡片将移除;若已配置 WebDAV 也会从云端移除。\n(若已在积分仪表盘导入,需再到仪表盘删一次)")) return;
    busy(true, delBtn);
    setStatus("删除中...");
    const r = await send({ action: "deleteCapture", uin });
    busy(false, delBtn);
    if (r && r.ok) {
      const st = await send({ action: "getState" });
      renderCards(st && st.accounts);
      const w = r.webdav || {};
      let msg = `✅ 已删除账号 ${r.uin}\n(本地卡片已移除`;
      if (w.removed) msg += `;云端 WebDAV 已移除并加墓碑)`;
      else if (w.error) msg += `;云端移除失败:${w.error},稍后重试或在服务器删)`;
      else msg += `;未配置 WebDAV)`;
      msg += `\n\n若已在积分仪表盘导入,请在那里也删一次。`;
      setStatus(msg, "ok");
    } else {
      setStatus("❌ " + ((r && r.error) || "删除失败"), "err");
    }
  }
});

// 初始化:回填配置与账号卡片
(async function init() {
  const st = await send({ action: "getState" });
  if (st && st.ok) {
    if (st.config && st.config.url) $("cfgUrl").value = st.config.url;
    if (st.config && st.config.user) $("cfgUser").value = st.config.user;
    if (st.config && st.config.pass) $("cfgPass").value = st.config.pass;
    renderCards(st.accounts);
  }
})();

// 打开 workbuddy.cn(便于登录 / 产生 cookie 后抓取)
$("btnOpen").onclick = () => {
  chrome.tabs.create({ url: "https://www.workbuddy.cn/", active: true });
};

// 打开 trae.cn(后续联调 trae 抓取,先提供入口方便登录产生 Cookie)
$("btnOpenTrae").onclick = () => {
  chrome.tabs.create({ url: "https://www.trae.cn/", active: true });
};

// 抓取:带名称(可留空) → 生成/更新一张卡片
$("btnCapture").onclick = async () => {
  busy(true, $("btnCapture"));
  setStatus("抓取中...");
  const r = await send({ action: "capture", name: $("nameInput").value.trim() });
  busy(false, $("btnCapture"));
  if (r && r.ok) {
    $("nameInput").value = "";
    const st = await send({ action: "getState" });
    renderCards(st && st.accounts);
    setStatus(
      `✅ 抓取成功,已生成卡片\n账号: ${r.rec.uin}\n名称: ${r.rec.name}\n积分: ${r.total} 包 / ${r.dosage} 分\n\n点「同步全部到 WebDAV」上传,或在仪表盘「一键同步」拉取。`,
      "ok"
    );
  } else {
    setStatus("❌ " + ((r && r.error) || "失败"), "err");
  }
};

// 同步全部本地账号到 WebDAV
$("btnSync").onclick = async () => {
  busy(true, $("btnSync"));
  setStatus("同步中...");
  const r = await send({ action: "sync" });
  busy(false, $("btnSync"));
  if (r && r.ok) {
    setStatus(
      `✅ 同步完成\n本次更新 ${r.merged} 个 / 新增 ${r.added} 个(云端共 ${r.totalAccounts} 个账号)\n已上传: ${r.url}\n\n现在去积分仪表盘点「☁️ 云同步 → 🔄 一键同步」即可导入。`,
      "ok"
    );
  } else {
    setStatus("❌ " + ((r && r.error) || "失败"), "err");
  }
};

// 导出文件:把全部卡片账号下载为 wb-accounts.json(标准格式),交给 WorkBuddy 直接灌入服务器
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
    `✅ 已导出 wb-accounts.json(${r.count} 个账号)\n\n把此文件发给 WorkBuddy(拖进对话或放到桌面),\n它会直接灌入积分仪表盘服务器,无需 WebDAV。`,
    "ok"
  );
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

// 一键清理:清空本地全部抓取账号(不动 WebDAV 云端)
$("btnClearAll").onclick = async () => {
  if (!confirm("确定一键清理所有抓取的账号?\n仅清除插件本地的抓取账号与备注。\n(WebDAV 云端不受影响,如需清云端请在积分仪表盘操作)")) return;
  busy(true, $("btnClearAll"));
  setStatus("清理中...");
  const r = await send({ action: "clearAll" });
  busy(false, $("btnClearAll"));
  if (r && r.ok) {
    const st = await send({ action: "getState" });
    renderCards(st && st.accounts);
    setStatus(`✅ 已一键清理 ${r.cleared} 个抓取账号的本地信息`, "ok");
  } else {
    setStatus("❌ " + ((r && r.error) || "清理失败"), "err");
  }
};