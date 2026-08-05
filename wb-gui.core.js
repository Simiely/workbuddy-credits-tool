// wb-gui.core.js — 网络请求 + 通用 UI 反馈/遮罩/管理员鉴权（wb-gui 拆分第 2 部分）
// 依赖 wb-gui.state.js（先加载）：$，__BASE__，busy/dashPer 等状态，LS_DAEMON_HIDE 等常量。

// ---- 管理员鉴权（简化版 v1.4.5）----
// 规则：管理按钮 = 密码唯一入口（无密码→设置；有密码→清除）。
// 危险操作(写类接口)：有密码且本会话未验证 → 先弹窗验证一次，通过后本次页面会话内放行；刷新后重新验证。无密码 → 完全开放。
let _adminTok = "";          // 本会话已验证的密码（内存，刷新即失效）
let _sessionAuthed = false;  // 本会话是否已验证过密码（设置/清除/验证任一成功后置 true）
let _adminMode = "verify";   // 当前弹窗模式: set(设置) | clear(清除) | verify(验证)
function adminToken() { return _adminTok; }
function setAdminToken(v) { _adminTok = v || ""; if (!_adminTok) _sessionAuthed = false; }

let toastTimer = null;

// ---- 统一请求:默认 15s 超时(批量刷新可传 timeout:30000)+ JSON + 错误抛出 ----
// ---- 管理员重新验证闸门 ----
// 写类接口若服务端返回 needAuth,api() 会弹出密码窗并通过该闸门等待用户验证,
// 验证通过后重试原请求;验证失败/取消则拒绝,原调用抛出"已取消/密码错误"。
let _adminGate = null;
function openAdminAndWait(mode) {
  if (!_adminGate) {
    _adminGate = {};
    _adminGate.p = new Promise((res, rej) => { _adminGate.res = res; _adminGate.rej = rej; });
  }
  openAdmin(mode || "verify");
  return _adminGate.p;
}
function resolveAdminGate() { if (_adminGate) { const r = _adminGate.res; _adminGate = null; r(); } }
function rejectAdminGate(msg) { if (_adminGate) { const rj = _adminGate.rej; _adminGate = null; rj(new Error(msg || "已取消")); } }

async function api(path, opts = {}) {
  const ctrl = new AbortController();
  const timeout = opts.timeout || 15000;
  const t = setTimeout(() => ctrl.abort(), timeout);
  const isWrite = /^(POST|DELETE|PUT|PATCH)$/i.test(opts.method || "");
  const isAdminSelf = path.indexOf("/api/admin/") === 0; // 密码接口自身不预验证(设置/验证/清除各自内部校验)
  const isReadOnlyPost = path.indexOf("/api/scheduler/run") !== -1; // 手动采样:只读、后端不要求管理员,无需弹密码
  try {
    // 会话级验证:有密码且本会话未验证过的写操作 → 先弹窗验证一次,通过后本次页面会话放行(刷新后重新验证)
    if (isWrite && !isAdminSelf && !isReadOnlyPost && adminEnabled && !_sessionAuthed) {
      await openAdminAndWait("verify");
    }
    let j;
    for (let attempt = 0; attempt < 2; attempt++) {
      // 管理员密码:写类接口附带 X-Admin-Token(仅内存,不信任请求体注入)
      const headers = Object.assign({}, opts.headers || {});
      const tk = adminToken();
      if (tk) headers["X-Admin-Token"] = tk;
      const r = await fetch(path, { ...opts, headers, signal: ctrl.signal });
      j = await r.json();
      // 服务端要求管理员密码(理论只在 token 失效时发生):重新验证一次后重试
      if (j && j.needAuth) {
        if (attempt === 0 && adminEnabled) { _sessionAuthed = false; await openAdminAndWait("verify"); continue; }
        throw new Error(j.error || "需要管理员密码");
      }
      break;
    }
    if (!j.ok) throw new Error(j.error || "请求失败");
    return j;
  } catch (e) {
    throw new Error(e.name === "AbortError" ? "请求超时(" + Math.round(timeout / 1000) + "s)" : e.message);
  } finally { clearTimeout(t); }
}

// ---- 轻提示 ----
function toast(msg, ms = 2600) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), ms);
}
function showErr(msg) { const e = $("err"); e.hidden = !msg; e.textContent = msg || ""; }
function showDaemon(msg) {
  const w = $("daemonWarn");
  if (!msg) { w.hidden = true; return; }
  if (localStorage.getItem(LS_DAEMON_HIDE)) return; // 已手动隐藏
  $("daemonMsg").textContent = msg;
  w.hidden = false;
}

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

// ---- 面板折叠(v1.4.38 从 state.js 归位):点击标题折叠/展开,状态存 localStorage ----
const LS_FOLD = "wb_fold"; // {trend:bool, overview:bool}
function toggleFold(head, ev) {
  if (ev && ev.target.closest && ev.target.closest("button")) return; // 标题内按钮(模式切换等)不触发折叠
  head.classList.toggle("folded");
  try {
    const st = JSON.parse(localStorage.getItem(LS_FOLD) || "{}");
    st[head.dataset.fold] = head.classList.contains("folded");
    localStorage.setItem(LS_FOLD, JSON.stringify(st));
  } catch {}
}
function applyFold() { // 启动时恢复上次折叠状态(由 actions 启动段调用,副作用收敛)
  try {
    const st = JSON.parse(localStorage.getItem(LS_FOLD) || "{}");
    document.querySelectorAll(".phead.foldable").forEach((el) => {
      if (st[el.dataset.fold]) el.classList.add("folded");
    });
  } catch {}
}

// ---- 遮罩/小弹窗/确认 ----
const openMask = (id) => $(id).classList.add("show");
const closeMask = (id) => $(id).classList.remove("show");
function closeModal() { closeMask("mask"); }

let small = null;
let smallCloseHook = null; // 小弹窗「✕/遮罩」关闭钩子：cfm 设为“取消”，普通弹窗(改名等)为 null 仅关闭
function openSmall(title, bodyHtml) {
  smallCloseHook = null;
  $("smallTitle").textContent = title;
  $("smallBody").innerHTML = bodyHtml;
  openMask("smallMask");
}
function closeSmall() {
  closeMask("smallMask");
  small = null;
  if (smallCloseHook) { const h = smallCloseHook; smallCloseHook = null; h(); }
}
// 通用确认弹窗：返回 Promise<boolean>，替代原生 confirm。
// 每次调用自建 Promise 与局部 resolve，无全局状态；关闭/取消均 resolve(false)。
function cfm(msg) {
  return new Promise((resolve) => {
    const done = (v) => { smallCloseHook = null; closeSmall(); resolve(v); };
    openSmall("确认操作", `<div class="tip t-bad">${msg}</div>
      <div class="factions"><button class="btn btn-g" id="cfmCancel">取消</button><button class="btn btn-d btn-lg" id="cfmOk">确认</button></div>`);
    $("cfmCancel").onclick = () => done(false);
    $("cfmOk").onclick = () => done(true);
    smallCloseHook = () => done(false); // ✕/遮罩关闭 = 取消
  });
}

// ---- 管理员（默认未启用；「🔒」按钮 = 密码唯一入口） ----
// adminEnabled 在 wb-gui.state.js 声明（共享全局），checkAdminStatus 启动时据 /api/admin/status 赋值。
// 三态弹窗：无密码→set(设置)；有密码点管理按钮→clear(输当前密码即清除)；危险操作首验→verify(验证后本次会话放行)
function openAdmin(mode) {
  if (!mode) mode = adminEnabled ? "clear" : "set"; // 管理按钮:无密码=设置,有密码=清除
  _adminMode = mode;
  const title = $("adminTitle"), tip = $("adminTip"), wrap = $("adminPass2Wrap"), ok = $("adminOk");
  if (mode === "set") {
    if (title) title.textContent = "🔒 设置管理密码";
    if (tip) tip.textContent = "设置后,危险操作(增删账号/清空/保存配置等)本次打开页面需验证一次密码。密码仅保存在本机。";
    if (wrap) wrap.hidden = false;
    if (ok) ok.textContent = "启用";
  } else if (mode === "clear") {
    if (title) title.textContent = "🔒 清除管理密码";
    if (tip) tip.textContent = "输入当前密码即可清除,清除后所有操作恢复开放(不可撤销)。";
    if (wrap) wrap.hidden = true;
    if (ok) ok.textContent = "清除";
  } else {
    if (title) title.textContent = "🔒 输入管理密码";
    if (tip) tip.textContent = "本次打开页面需验证一次密码,验证后本会话内危险操作不再询问。";
    if (wrap) wrap.hidden = true;
    if (ok) ok.textContent = "确认";
  }
  openMask("adminMask");
  setTimeout(() => {
    const i = $("adminPass"); if (i) { i.focus(); i.value = ""; }
    const i2 = $("adminPass2"); if (i2) i2.value = "";
  }, 60);
}
function closeAdmin() { closeMask("adminMask"); rejectAdminGate("已取消"); }
async function confirmAdmin() {
  const v = (($("adminPass") || {}).value || "").trim();
  if (!v) return toast("请输入密码");
  if (!adminEnabled) {
    // 设置模式:两次输入一致 → 启用
    const v2 = (($("adminPass2") || {}).value || "").trim();
    if (v !== v2) return toast("两次输入的密码不一致");
    try {
      const r = await api(__BASE__ + "/api/admin/setup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pass: v }),
      });
      if (!r.ok) throw new Error(r.error || "设置失败");
      setAdminToken("");    // 设置不算验证:紧随其后的危险操作仍需输入刚设置的密码验证一次
      _sessionAuthed = false;
      adminEnabled = true;
      updateAdminBtn();
      closeAdmin();
      toast("✅ 已启用管理密码");
      refreshAll(false);
    } catch (e) { toast("❌ " + e.message); }
    return;
  }
  try {
    if (_adminMode === "clear") {
      // 清除模式:用刚输入的当前密码直接调 clear(body token 自校验),不依赖任何缓存
      setAdminToken(""); // 清掉本会话残留 token,确保校验用的就是刚输入的密码
      const r = await api(__BASE__ + "/api/admin/clear", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: v }),
      });
      if (!r.ok) throw new Error(r.error || "清除失败");
      setAdminToken("");
      _sessionAuthed = false;
      adminEnabled = false;
      updateAdminBtn();
      closeAdmin();
      toast("✅ 已清除管理密码,操作恢复开放");
    } else {
      // 验证模式:密码正确 → 本次会话放行
      const r = await api(__BASE__ + "/api/admin/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: v }),
      });
      if (!r.ok) throw new Error(r.error || "验证失败");
      setAdminToken(v);
      _sessionAuthed = true;
      resolveAdminGate(); // 放行 api() 中等待的写操作(重试会带本会话 token)
      closeAdmin();
      toast("✅ 已通过验证,本次打开页面内操作放行");
    }
  } catch (e) { setAdminToken(""); rejectAdminGate(e.message); toast("❌ " + e.message); }
}

// WebDAV 默认地址（供 syncCfg 使用；保存时原样，不保存此默认）
const SYNC_DEFAULT_URL = "http://192.168.2.1:6086/";
