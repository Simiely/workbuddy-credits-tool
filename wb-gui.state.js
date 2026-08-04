// wb-gui.state.js — 共享状态 + 纯函数/常量（wb-gui 拆分第 1 部分）
// 约定：本文件与 wb-gui.core.js / wb-gui.render.js / wb-gui.actions.js 同为 classic <script>，
// 按 state → core → render → actions 顺序加载，共享同一全局词法作用域（顶层 const/let/function 跨文件可见）。
// 本文件只放声明，不放置会触发副作用的顶层语句（副作用集中在 wb-gui.actions.js 的启动段）。

const __BASE__ = window.__BASE__ || "";
const $ = (id) => document.getElementById(id);
const fmt = (n) => Math.round((n || 0) * 100) / 100;
const acctName = (a) => (a && (a.displayName || "").trim()) || (a && a.name) || "账号";
const totalOf = (s) => (s ? (s.baseRemain ?? 0) + s.giftRemain : 0);
const LINE_COLORS = ["#ff9292", "#5ad8a6", "#f6bd16", "#e8684a", "#6dc8ec", "#9270ca", "#ff9d4d", "#269a99", "#ff99c3", "#8378ea"];

// ---- 共享可变状态（所有模块读写同一批顶层 let）----
let S = null;            // 账号列表(唯一真相源){results:[{account,summary,data,derived}], fetchedAt}
let busy = false;        // 刷新锁
let dashPer = [];        // 仪表盘投影:由 S.results 经 mergeDerived 重建,表格/折线只读它
let dashMode = "day";
let autoTimer = null;
let autoOn = localStorage.getItem("wb_auto_on") !== "0";
let autoMin = parseInt(localStorage.getItem("wb_auto_min") || "5", 10) || 5;
let lastSfp = null;
let dragId = null;
let suppressClick = false; // 拖拽后抑制一次点击,避免误开明细
let es = null;            // EventSource 实例
let streamOk = false;     // SSE 连接状态
let syncBusy = false;
let adminEnabled = false; // 管理员密码是否已启用(据 /api/admin/status 启动时赋值;启用后写操作需密码)

const LS_ON = "wb_auto_on", LS_MIN = "wb_auto_min";
const LS_DAEMON_HIDE = "wb_daemon_hide"; // 用户手动隐藏过 daemon 提示后不再打扰

// 属性转义（innerHTML 注入用）
const escAttr = (s) => String(s || "").replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

// 过期分层：直接读账号对象上挂载的 derived（doRefresh 时由后端派生合并，单一来源）
function derivedOf(r) { return (r && r.derived) || {}; }
function expiryTier(r) { return ((r && r.derived) || {}).expiryTier || { tier: Infinity, amount: 0 }; }
