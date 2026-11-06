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

// ---- v1.10.17 锁滚动不位移 ----
// 放大时 body 加 overflow:hidden,右侧滚动条消失 → 视口凭空宽出约 15px,整页内容右移,
// 紧接着叠上磨砂模糊,观感就是"背景先跳一下再糊"。做法:改 overflow 之前先量出滚动条宽度,
// 用它补 padding-right;解锁时还原。这样内容位置前后完全一致。
function lockBodyScroll() {
  const sw = window.innerWidth - document.documentElement.clientWidth; // 必须在改 overflow 之前量
  const cur = parseFloat(getComputedStyle(document.body).paddingRight) || 0;
  document.body.style.overflow = "hidden";
  document.body.style.paddingRight = sw > 0 ? (cur + sw) + "px" : "";
}
function unlockBodyScroll() {
  document.body.style.overflow = "";
  document.body.style.paddingRight = "";
}

// ---- v1.10.3 面板放大:点标题把该面板 .pbody 整块搬进近满屏层 ----
// 为什么搬节点而不是克隆:总览/趋势的渲染函数都是 getElementById 定点写入,
// 克隆会产生重复 id(渲染写到旧节点、屏幕上是副本)。搬运保证 id 唯一、事件与
// 滚动位置语义连续,关闭时按原位置插回。
// v1.10.12:搬运会让原面板只剩标题、看着像"被折叠了"。所以在原位补一份
// **无 id 的静态替身**(ghost):原面板内容保持原样,放大层里是可交互的真身。
// 替身必须剥掉 id 才不会有重复 id —— 否则 getElementById 先命中原位的替身,
// 渲染全写到死节点上(和克隆方案踩的是同一个坑)。
let _zoom = null;
function statClone(node) {
  const c = node.cloneNode(true);
  c.querySelectorAll("[id]").forEach((n) => n.removeAttribute("id"));
  // 替身只做样子:不接收指针/焦点事件,不进无障碍树
  c.classList.add("zoom-ghost");
  c.setAttribute("aria-hidden", "true");
  c.style.pointerEvents = "none";
  if ("inert" in c) c.inert = true;
  // cloneNode 只复制 attribute,复制不到 JS 赋过的当前值 → 手工同步表单值
  const from = node.querySelectorAll("input,select,textarea");
  const to = c.querySelectorAll("input,select,textarea");
  for (let i = 0; i < from.length && i < to.length; i++) {
    if (from[i].tagName === "SELECT" || from[i].tagName === "TEXTAREA" || from[i].type !== "checkbox") {
      to[i].value = from[i].value;
    }
    to[i].checked = from[i].checked;
  }
  return c;
}
function zoomPanel(head, ev) {
  // 标题栏里的按钮/日期框是操作,不触发放大
  if (ev && ev.target.closest && ev.target.closest("button,input,select,textarea,label,a")) return;
  const panel = head && head.closest ? head.closest(".panel") : null;
  // :not(.zoom-ghost) 兜底:万一替身没被清掉,也不能把替身当真身搬走
  const body = panel && panel.querySelector(".pbody:not(.zoom-ghost)");
  if (!body || _zoom) return;
  const h2 = head.querySelector("h2");
  // v1.12.2:标题栏右侧的操作(今日/每周/每月/全部 + 截止日)不在 .pbody 里,放大后会"消失"。
  // 这里把整块 .phead-r 搬进放大层头部 —— 搬的是同一批节点,id 与 onclick 都不变,切模式照旧生效。
  const headR = head.querySelector(".phead-r");
  _zoom = {
    body, parent: body.parentNode, next: body.nextSibling, id: panel.id, ghost: null,
    tools: headR, toolsParent: headR ? headR.parentNode : null, toolsNext: headR ? headR.nextSibling : null,
  };
  const title = $("zoomTitle");
  if (title) title.textContent = h2 ? h2.textContent.trim() : "";
  if (headR) { const slot = $("zoomTools"); if (slot) slot.appendChild(headR); }
  // 先在原位放替身(视觉上原面板不变),再把真身搬进放大层
  try {
    _zoom.ghost = statClone(body);
    body.parentNode.insertBefore(_zoom.ghost, body);
  } catch (e) { _zoom.ghost = null; }
  $("zoomBody").appendChild(body);
  $("zoomMask").classList.add("show");
  lockBodyScroll();
  // 趋势图按新容器宽度重绘(其余面板是静态 DOM,无需重绘)
  if (panel.id === "trendPanel" && typeof renderLines === "function") requestAnimationFrame(() => renderLines());
}
function closeZoom() {
  if (!_zoom) return;
  const { body, parent, next, id, ghost, tools, toolsParent, toolsNext } = _zoom;
  if (next && next.parentNode === parent) parent.insertBefore(body, next);
  else parent.appendChild(body);
  if (ghost && ghost.parentNode) ghost.parentNode.removeChild(ghost);
  // 把标题栏操作搬回原位(顺序:先回正文,再回操作)
  if (tools && toolsParent) {
    if (toolsNext && toolsNext.parentNode === toolsParent) toolsParent.insertBefore(tools, toolsNext);
    else toolsParent.appendChild(tools);
  }
  _zoom = null;
  const mask = $("zoomMask");
  if (mask) mask.classList.remove("show");
  unlockBodyScroll();
  if (id === "trendPanel" && typeof renderLines === "function") requestAnimationFrame(() => renderLines());
}

// ---- 遮罩/小弹窗/确认 ----
const openMask = (id) => $(id).classList.add("show");
const closeMask = (id) => $(id).classList.remove("show");
function closeModal() { closeMask("mask"); }

// ---- 顶栏:横排 / 收起 两态(v1.11.0 整块重写) ----
// 收起时中间那排动作变成头下方的卡片,「刷新全部」始终留在最外面(它不在 .top-acts 里)。
// 收不收由 fitTopBar() 实测:量「标题 + 间距 + 按钮组单行自然宽」,余量不足 TOPBAR_GAP_MIN 就收。
// 触发:启动、resize(去抖)、字体加载完成、以及「自动同步」块显隐后(都会改变所需宽度)。
const TOPBAR_GAP_MIN = 160;   // 横排至少要留出的空隙 ≈ 两个按钮宽
let _manage = false;          // 卡片是否展开
let _fitRaf = 0;

function toggleManage(force) {
  const box = $("topActs");
  if (!box) return;
  _manage = force === undefined ? !_manage : !!force;
  box.classList.toggle("open", _manage);
  const b = $("btnManage");
  if (b) b.setAttribute("aria-expanded", _manage ? "true" : "false");
}
function closeManage() { if (_manage) toggleManage(false); }

// 量「顶栏那一行需要多宽」:把在流里的子项(标题 / 同步动作 / 管理 / 刷新)宽度加起来。
// .top-acts 是绝对定位的菜单,不占行宽,排除掉。measuring 态里谁都不许被压扁 → 量到的是自然宽。
function topBarNeed() {
  const top = document.querySelector(".top");
  const bar = top && top.querySelector(".top-in");
  const acts = $("topActs");
  if (!top || !bar) return null;
  top.classList.add("measuring");
  try {
    const gap = parseFloat(getComputedStyle(bar).columnGap) || 0;
    const kids = Array.prototype.slice.call(bar.children)
      .filter((c) => c !== acts && c.getBoundingClientRect().width > 0);
    const need = kids.reduce((s2, c) => s2 + c.getBoundingClientRect().width, 0)
      + gap * Math.max(0, kids.length - 1);
    return { need, avail: bar.clientWidth };
  } finally {
    top.classList.remove("measuring");   // 无论如何都要还原,否则整页停在"量宽态"
  }
}

function fitTopBar() {
  const top = document.querySelector(".top");
  if (!top) return;
  top.classList.remove("compact");                  // 先按横排量
  const m = topBarNeed();
  if (!m) return;
  const crowded = m.need + TOPBAR_GAP_MIN > m.avail;
  if (crowded) top.classList.add("compact");
  // 注意:这里**不要**去关「管理」菜单 —— 它是常驻浮层,与横排/收起无关。
  // v1.11.0 曾在此处"不是收起态就 closeManage()",结果 fonts.ready 再拟合一次时
  // 把用户刚点开的菜单关掉了(表现为"点了没反应")。
}
// 立即修正,但用 rAF 合并同一帧的多次事件。
// 关键:不能用 setTimeout 去抖 —— 拖动窗口时浏览器会先按"换行"画一帧,去抖到期才收起,
// 视觉上就是"先弹到第二排、再缩回去"。rAF 在绘制前执行,那一帧永远不会被画出来。
function scheduleFitTopBar() {
  if (_fitRaf) return;
  _fitRaf = requestAnimationFrame(() => { _fitRaf = 0; fitTopBar(); });
}

let _topInit = false;
function initTopBar() {
  fitTopBar();                          // 每次都重算
  if (_topInit) return;                 // 监听只接一次
  _topInit = true;
  window.addEventListener("resize", scheduleFitTopBar);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(fitTopBar).catch(() => {});
  // 收起卡片的三条关闭路径:点卡片里的动作按钮 / 点卡片外 / Esc(见 actions.js)
  document.addEventListener("click", (e) => {
    if (!_manage) return;
    const t = e.target;
    if (!t || !t.closest) return;
    if (t.closest("#btnManage")) return;            // 开/关交给按钮自己
    const box = $("topActs");
    if (box && box.contains(t)) {
      if (t.closest(".btn")) closeManage();         // 点动作按钮 → 收起
      return;                                       // 点数字框/开关不收起
    }
    closeManage();                                  // 点卡片外 → 收起
  });
}

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

// 据启用状态更新 🔒 按钮文案/提示(UI 基础设施,归位 core;actions 的 checkAdminStatus 调用它)
function updateAdminBtn() {
  const b = $("btnAdmin");
  if (!b) return;
  b.hidden = false;
  if (adminEnabled) { b.textContent = "🔒 管理"; b.title = "点击清除管理密码(危险操作需先验证一次密码)"; }
  else { b.textContent = "🔒 设置密码"; b.title = "点击设置管理密码(启用后危险操作需验证一次)"; }
}

// 间隔输入(change)通用绑定:校验 1..max → 存 localStorage → 应用并提示。
// 页面自动刷新(autoMin)与自动上传(autoUpH)共用,避免两个监听器复制粘贴(v1.4.43 审计修复)
function bindIntervalInput(elId, getVal, setVal, max, storeKey, applyFn, msg) {
  const el = $(elId);
  if (!el) return;
  el.addEventListener("change", () => {
    const v = parseInt(el.value, 10);
    if (!v || v < 1) { el.value = getVal(); return; }
    const nv = v > max ? max : v;
    setVal(nv);
    localStorage.setItem(storeKey, String(nv));
    el.value = String(nv);
    applyFn();
    toast(msg(nv));
  });
}

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
