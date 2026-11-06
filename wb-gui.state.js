// wb-gui.state.js — 共享状态 + 纯函数/常量（wb-gui 拆分第 1 部分）
// 约定：本文件与 wb-gui.core.js / wb-gui.render.js / wb-gui.chart.js / wb-gui.ops.js / wb-gui.sync.js /
//       wb-gui.actions.js 同为 classic <script>，按 state → core → render → chart → ops → sync → actions
//       顺序加载，共享同一全局词法作用域（顶层 const/let/function 跨文件可见）。
// 本文件只放声明，不放置会触发副作用的顶层语句（副作用集中在 wb-gui.actions.js 的启动段）。

const __BASE__ = window.__BASE__ || "";
const $ = (id) => document.getElementById(id);
const fmt = (n) => Math.round((n || 0) * 100) / 100;
const acctName = (a) => (a && (a.displayName || "").trim()) || (a && a.name) || "账号";
const totalOf = (s) => (s ? (s.giftRemain ?? 0) : 0); // TRAE 无体验版 base,总剩余即积分池剩余

// ---- 自然日口径（v1.12.5）：前端统一按中国时区 +8，与后端 src/time.js 同源 ----
// 之前图表/KPI 用浏览器本地时区算"今天/昨天/某天"，只在 GMT+8 的机器上碰巧正确：
//   · 浏览器在 UTC：北京时间 00:30 的消耗会被归到前一天 → 柱子错位一天；
//   · 浏览器在 UTC-4/-5：todayStr() 直接比后端早一天 → 「今日/每周」整条窗口偏移。
// 这里只做一次换算，其余各处一律调 cnKey / cnDayIso，不许再各自拼日期。
// 实现要点：把时刻 +8h 后，用 getUTC* 读出来就是北京墙上时间（不受进程时区影响）。
const CN_OFF = 8 * 3600 * 1000;
const cnWall = (ts) => new Date(new Date(ts).getTime() + CN_OFF);
const cnKey = (ts) => {
  const z = cnWall(ts);
  return `${z.getUTCFullYear()}-${String(z.getUTCMonth() + 1).padStart(2, "0")}-${String(z.getUTCDate()).padStart(2, "0")}`;
};
/** 该自然日 00:00(+8) 对应的真实时刻 ISO —— 图表内部用它当日标识 */
const cnDayIso = (ts) => {
  const z = cnWall(ts);
  return new Date(Date.UTC(z.getUTCFullYear(), z.getUTCMonth(), z.getUTCDate()) - CN_OFF).toISOString();
};
/** 月键 "YYYY-MM"(+8) */
const cnMonthKey = (ts) => cnKey(ts).slice(0, 7);

const LINE_COLORS = ["#ff9292", "#5ad8a6", "#f6bd16", "#e8684a", "#6dc8ec", "#9270ca", "#ff9d4d", "#269a99", "#ff99c3", "#8378ea"];

// ---- 软件源(多软件积分)展示表：账号.appKey → 显示名。未来加软件在此追加即可，前端零硬编码 ----
const APP_LABELS = { traework: "TRAE Work", workbuddy: "WorkBuddy" };
const appLabel = (a) => APP_LABELS[(a && a.appKey) || "traework"] || (a && a.appKey) || "TRAE Work";

// ---- 共享可变状态（所有模块读写同一批顶层 let）----
let S = null;            // 账号列表(唯一真相源){results:[{account,summary,data,derived}], fetchedAt}
let busy = false;        // 刷新锁
let dashPer = [];        // 仪表盘投影:由 S.results 经 mergeDerived 重建,表格/折线只读它
let dashMode = "week"; // v1.10.11:默认「每周」(今天往前 7 天逐日);v1.10.3~v1.10.10 为「今日」
let trendEnd = "";        // 每日视图截止日期("YYYY-MM-DD",空=默认动态窗口;选中后以该日为终点向前显示 5 天,不持久化)
let autoTimer = null;
let autoOn = localStorage.getItem("wb_auto_on") !== "0";
let autoMin = parseInt(localStorage.getItem("wb_auto_min") || "5", 10) || 5;
let autoUpTimer = null;                                 // 自动同步定时器(WebDAV,默认 12 小时一次)
let autoUpOn = localStorage.getItem("wb_auto_up_on") === "1";
let autoUpH = parseInt(localStorage.getItem("wb_auto_up_h") || "12", 10) || 12;
let lastSfp = null;
let dragId = null;
let suppressClick = false; // 拖拽后抑制一次点击,避免误开明细
let es = null;            // EventSource 实例
let streamOk = false;     // SSE 连接状态
let syncBusy = false;
let adminEnabled = false; // 管理员密码是否已启用(据 /api/admin/status 启动时赋值;启用后写操作需密码)

const LS_ON = "wb_auto_on", LS_MIN = "wb_auto_min";
const LS_UP_ON = "wb_auto_up_on", LS_UP_H = "wb_auto_up_h"; // 自动同步(WebDAV):开关 + 间隔(小时)
const LS_DAEMON_HIDE = "wb_daemon_hide"; // 用户手动隐藏过 daemon 提示后不再打扰

// ---- v1.10.0 单屏工作台:总览表格的视图态（会话内有效,不持久化）----
// viewFilter: all | traework | workbuddy | warn（⚠ 需关注=查询失败∪今日未签到,只收当天要行动的事;
//             临期是这些账号的常态,不当例外 —— 实测 12 账号 10 个"近7天有临期"）
// viewSort:   null = 池序（账号池手动/一键排序的持久顺序）;否则 {key, dir:"desc"|"asc"} 视图级排序。
//             v1.12.7:默认改为「近1天 从多到少」——总览打开即先看最紧迫的到期（用户指定）。
//             视图排序刻意**不写回账号池** —— 与池序是两层：池序由「一键排序/卡片拖拽」持久化（ops.js），
//             列头排序只是看数据的透镜（W3C ARIA: 默认序应匹配最高频用途;池序即用户的常用序）。
let viewFilter = "all";
let viewSort = { key: "exp1", dir: "desc" }; // v1.12.7:默认「近1天」降序（点表头三态循环:降→升→回池序）

// 属性/文本转义（innerHTML 注入统一入口；v1.4.45 补 > 与 ' 转义,防止"改名"等自定义内容破坏页面）
const escAttr = (s) =>
  String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/'/g, "&#39;");

// 过期分层：直接读账号对象上挂载的 derived（doRefresh 时由后端派生合并，单一来源）
function derivedOf(r) { return (r && r.derived) || {}; }
// 后端 tier 用 Infinity 表示"无到期压力"，但 Infinity 经 JSON 序列化会变 null，
// 此处统一归一：null/缺失/非数字 → Infinity，避免 null 当 0 参与比较导致无压力账号排最前
function expiryTier(r) {
  const t = ((r && r.derived) || {}).expiryTier || {};
  return { tier: typeof t.tier === "number" ? t.tier : Infinity, amount: t.amount || 0 };
}
