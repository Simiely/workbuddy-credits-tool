// wb-gui.mjs - WorkBuddy 积分仪表盘 GUI 服务（薄路由层）
// 业务全在 src/：查询/渲染走 src/compute，采集走 src/collect，渲染走 src/present。
// 启动: node wb-gui.mjs [端口], 默认 8080, 被占用自动顺延(≤8090)
//
// 路由层收敛（P6）：全部端点登记到 routes 表（method + path 精确匹配），
// 管理员校验统一在分发层做（route.admin 标记 + adminDenied），handler 内不再重复鉴权。
//
// ==================== 文件地图（改代码前先看这里） ====================
// 全文件按「顶部基础设施 → 路由表 → 分发层 → 启动」四段组织:
//
//   【A. 顶部基础设施】(约 7-135 行)
//      · getDerived()               —— 唯一派生源 = deriveAll(账号池),只读不写
//      · adminPass/readAdminToken/adminDenied —— 管理员鉴权,写类接口统一在这校验
//      · broadcastRefresh           —— SSE 广播:新快照后推 refresh 事件给前端
//      · readBody()                 —— POST 请求体解析(1MB 上限),分发层共用
//
//   【B. 路由表 routes】(约 140-561 行,文件主体)
//      · 31 个端点,method + path 精确匹配;搜 path: "/api/ 可列出全部接口
//      · 约定: admin:true = 写类接口,分发层统一鉴权,handler 内不重复鉴权
//      · handler 通过 ctx.json / ctx.respondRaw 回写,不直接操作 res
//
//   【C. HTTP 分发层】(约 563-618 行)
//      · body 解析(1MB) → 路由匹配 → route.admin 时 adminDenied → handler
//      · 新增接口 = 在路由表加一条,鉴权自动生效,无需改这里
//
//   【D. 启动 listen】(约 620 行起)
//      · 端口顺延(8080→8090) · 桌面自动开浏览器 · 启动采样调度器/WebDAV 同步
//
// 业务逻辑(查询/派生/采集/同步)全部在 src/,本文件只做"接线"。
// 行号仅供参考(可能漂移),定位请按上方段名搜索。
// =====================================================================
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { ROOT, TOOLS_DIR, DAEMON_PORT, GUI_PORT } from "./src/config.js";
import {
  loadAccounts,
  saveAccounts,
  findAccount,
  clearAccounts,
  ACCOUNTS_FILE,
  exportLegacy as exportAccounts,
  importLegacy as importAccounts,
} from "./src/compute/store.js";
import { fetchAllAccounts, fetchOneAccount } from "./src/compute/query.js";
import { sampleAll } from "./src/compute/sample.js";
import { saveCurrentFromEdge } from "./src/compute/account-ops.js";
import { brief, mdAll } from "./src/present/render.js";
import {
  saveLastData,
  loadLastData,
  historyFor,
  latestReadingTs,
  clearReadings,
  exportLegacy as exportHistory,
  importLegacy as importHistory,
  LAST_FILE,
} from "./src/compute/history.js";
import { deriveAll } from "./src/compute/derive.js";
import {
  loadSyncConfig,
  saveSyncConfig,
  uploadFile,
  downloadFile,
  testConnection,
  BACKUP_DIR,
  SYNC_FILES,
  SYNC_FILE,
} from "./src/compute/webdav.js";
import { collectorStatus, syncFromWebDAV } from "./src/collect/index.js";
import {
  start as startScheduler,
  stop as stopScheduler,
  runNow as runSchedulerNow,
  getStatus as getSchedulerStatus,
  setNotifier as setSchedulerNotifier,
} from "./src/compute/scheduler.js";

const HTML_FILE = path.join(ROOT, "wb-gui.html");
const DAEMON_BASE = `http://127.0.0.1:${DAEMON_PORT}`;

// dashboard/all 内存缓存 {key, payload}
let dashCache = null;

// ---------- 派生视图(读)：唯一派生源 = deriveAll(账号池) ----------
// 前端 dashboard/明细/CLI 都消费这一处,避免散落重复计算。
// 注意:本函数不写任何数据,只读取 readings 表派生,符合「Readings(写)/Derived(读)」收敛。
function getDerived() {
  return deriveAll(loadAccounts());
}

// ---------- 管理员鉴权（默认未启用；首次运行时由前端 /api/admin/setup 设置密码并持久化） ----------
// adminPass 为空 → 开放（本地单用户默认）；设置后写类接口需携带 X-Admin-Token 且匹配才放行。
// 密码持久化在 wb-admin.json（与 wb-sync.json 同级，明文，本地单用户可接受）。
const ADMIN_FILE = path.join(TOOLS_DIR, "wb-admin.json");
let adminPass = "";
try {
  const _a = JSON.parse(fs.readFileSync(ADMIN_FILE, "utf8"));
  adminPass = typeof _a.pass === "string" ? _a.pass : "";
} catch {}
function setAdminPass(p) {
  adminPass = p;
  fs.writeFileSync(ADMIN_FILE, JSON.stringify({ pass: p }, null, 2), "utf8");
}
function readAdminToken(req, url, bodyObj) {
  let h = req.headers["x-admin-token"] || req.headers["authorization"] || "";
  if (Array.isArray(h)) h = h[0];
  if (typeof h === "string" && h.toLowerCase().startsWith("bearer ")) return h.slice(7).trim();
  if (typeof h === "string" && h) return h.trim();
  if (url.searchParams.get("token")) return url.searchParams.get("token");
  if (bodyObj && bodyObj.token) return bodyObj.token;
  return "";
}
// 返回 true = 需要拒绝（未配置或令牌不匹配）；false = 放行。
function adminDenied(ctx) {
  if (!adminPass) return false; // 未配置=开放
  return readAdminToken(ctx.req, ctx.url, ctx.bodyObj) !== adminPass;
}

// ---------- SSE 实时推送（零依赖：纯 HTTP 流，替代前端轮询） ----------
const sseClients = new Set();
function broadcastRefresh(meta) {
  if (!sseClients.size) return;
  const payload = JSON.stringify({ ts: new Date().toISOString(), ...(meta || {}) });
  const frame = `event: refresh\ndata: ${payload}\n\n`;
  for (const c of sseClients) {
    try {
      c.write(frame);
    } catch {
      sseClients.delete(c);
    }
  }
}

// WebDAV 同步配置（模块级，供多个写接口共用）
function syncCfg() {
  const c = loadSyncConfig();
  if (!c || !c.user) throw new Error("未配置 WebDAV 账号,请先填写用户名密码并「保存配置」");
  return { ...c, url: c.url || "http://192.168.2.1:6086/" };
}

// 固定中国时区(+8)格式化当前时间：不依赖进程时区（容器默认 UTC 时 toLocaleString 会错位显示）
// 与 derive.js 的自然日口径一致，保证所有部署环境显示同一时刻
function cnNow() {
  const d = new Date(Date.now() + 8 * 3600000); // 平移至 UTC+8 墙钟
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}/${p(d.getUTCMonth() + 1)}/${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}

// 读取请求体（含 1MB 上限保护）
function readBody(req) {
  return new Promise((resolve, reject) => {
    let s = "";
    let size = 0;
    req.on("data", (c) => {
      s += c;
      size += c.length;
      if (size > 1024 * 1024) {
        reject(new Error("请求体过大"));
        req.destroy();
      }
    });
    req.on("end", () => resolve(s));
    req.on("error", reject);
  });
}

// ==================== 路由表（method + path 精确匹配） ====================
// 约定：handler(ctx) 通过 ctx.json(code,obj) 回 JSON，或 ctx.respondRaw(code,headers,content) 回原始内容。
// admin:true 的路由在分发前统一校验 adminPass（来自 wb-admin.json），handler 内不再重复鉴权。
const routes = [
  // ---------- 静态/传输 ----------
  {
    method: "GET",
    path: "/",
    handler: (ctx) =>
      ctx.respondRaw(
        200,
        { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
        fs.existsSync(HTML_FILE) ? fs.readFileSync(HTML_FILE, "utf8") : "<h1>wb-gui.html 缺失</h1>"
      ),
  },
  // 前端拆分为 7 个 classic <script>（共享全局词法作用域，按 state→core→render→chart→ops→sync→actions 顺序加载）
  ...["wb-gui.state.js", "wb-gui.core.js", "wb-gui.render.js", "wb-gui.chart.js", "wb-gui.ops.js", "wb-gui.sync.js", "wb-gui.actions.js"].map((f) => ({
    method: "GET",
    path: "/" + f,
    handler: (ctx) =>
      ctx.respondRaw(
        200,
        { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "no-store" },
        fs.existsSync(path.join(ROOT, f)) ? fs.readFileSync(path.join(ROOT, f), "utf8") : "// missing"
      ),
  })),
  {
    method: "GET",
    path: "/api/stream",
    handler: (ctx) => {
      const { res, req } = ctx;
      ctx.responded = true;
      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "Access-Control-Allow-Origin": "*",
      });
      res.write("retry: 5000\n\n");
      sseClients.add(res);
      const ping = setInterval(() => {
        try {
          res.write(": ping\n\n");
        } catch {
          clearInterval(ping);
          sseClients.delete(res);
        }
      }, 25000);
      req.on("close", () => {
        clearInterval(ping);
        sseClients.delete(res);
      });
    },
  },

  // ---------- 读接口（无需鉴权） ----------
  {
    method: "GET",
    path: "/api/status",
    handler: async (ctx) => {
      let daemon = "down";
      try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 2500);
        const r = await fetch(`${DAEMON_BASE}/status`, { signal: ctrl.signal });
        const j = await r.json();
        clearTimeout(t);
        daemon = j.connected ? "ok" : "down";
      } catch {}
      ctx.json(200, { ok: true, daemon, collector: collectorStatus() });
    },
  },
  {
    method: "GET",
    path: "/api/accounts",
    handler: (ctx) => {
      const accounts = loadAccounts().map((a) => ({
        id: a.id,
        name: a.name,
        displayName: a.displayName,
        uin: a.uin,
        lastStatus: a.lastStatus,
        sessionExpiresAt: a.sessionExpiresAt,
      }));
      ctx.json(200, { ok: true, accounts });
    },
  },
  {
    method: "GET",
    path: "/api/all",
    handler: async (ctx) => {
      const { raw } = await sampleAll(); // 统一采样入口：采集→buildSnapshotEntry→appendSnapshot 在 sample.js（不广播,避免与 SSE 刷新风暴）
      const results = raw.map((r) => ({
        account: brief(r.account),
        summary: r.summary,
        data: r.data,
        error: r.error,
        expired: r.expired,
      }));
      const payload = { ok: true, fetchedAt: cnNow(), results };
      saveLastData({ fetchedAt: payload.fetchedAt, results }); // 本地缓存（离线可看）
      ctx.json(200, payload);
    },
  },
  {
    method: "GET",
    path: "/api/last",
    handler: (ctx) => {
      const last = loadLastData();
      ctx.json(200, last ? { ok: true, ...last } : { ok: false, error: "暂无本地缓存,刷新一次后生成" });
    },
  },
  {
    method: "GET",
    path: "/api/history",
    handler: (ctx) => {
      const key = ctx.url.searchParams.get("account") || "";
      const accounts = loadAccounts();
      const a = findAccount(accounts, key);
      if (!a) return ctx.json(404, { ok: false, error: "账号不存在" });
      const hist = historyFor(a.uin).slice(-30);
      ctx.json(200, { ok: true, account: brief(a), history: hist });
    },
  },
  {
    method: "GET",
    path: "/api/dashboard/all",
    handler: (ctx) => {
      // 缓存键 = 最新快照时间 + 账号池指纹(增删账号后派生必须失效,否则同分钟去重场景下新账号派生滞后)
      const acctSig = loadAccounts().map((a) => a.uin || a.id).join(",");
      const cacheKey = latestReadingTs() + "|" + new Date().toDateString() + "|" + acctSig;
      if (dashCache && dashCache.key === cacheKey) {
        return ctx.json(200, { ok: true, ...dashCache.payload });
      }
      const per = getDerived();
      dashCache = { key: cacheKey, payload: { per } };
      ctx.json(200, { ok: true, per });
    },
  },
  {
    method: "GET",
    path: "/api/admin/status",
    handler: (ctx) => ctx.json(200, { ok: true, required: !!adminPass, enabled: !!adminPass }),
  },
  {
    // 首次设置管理密码（未启用时免验证；启用后需先验证旧密码方可修改）
    method: "POST",
    path: "/api/admin/setup",
    handler: (ctx) => {
      if (adminPass) return ctx.json(400, { ok: false, error: "管理密码已设置,无法重复设置(如需重置,删除 wb-admin.json 后重启)" });
      const p = String(ctx.bodyObj.pass || "").trim();
      if (p.length < 4) return ctx.json(400, { ok: false, error: "密码至少 4 位" });
      setAdminPass(p);
      ctx.json(200, { ok: true });
    },
  },
  {
    // 验证密码（已启用时前端「输入密码」调用）；明文比对,仅本地
    method: "POST",
    path: "/api/admin/verify",
    handler: (ctx) => {
      if (!adminPass) return ctx.json(200, { ok: true, enabled: false });
      const tok = String(ctx.bodyObj.token || "").trim();
      if (tok !== adminPass) return ctx.json(401, { ok: false, error: "密码错误" });
      ctx.json(200, { ok: true });
    },
  },
  {
    // 清除管理密码（需先通过管理员鉴权；清除后写操作恢复开放,需重新设置）
    method: "POST",
    path: "/api/admin/clear",
    admin: true,
    handler: (ctx) => {
      try { fs.rmSync(ADMIN_FILE, { force: true }); } catch {}
      adminPass = "";
      ctx.json(200, { ok: true });
    },
  },
  {
    method: "GET",
    path: "/api/derived",
    handler: (ctx) => {
      const key = (ctx.url.searchParams.get("account") || "").trim();
      if (key) {
        const accounts = loadAccounts();
        const a = findAccount(accounts, key);
        if (!a) return ctx.json(404, { ok: false, error: "账号不存在" });
        const [derived] = deriveAll([a]);
        return ctx.json(200, { ok: true, derived });
      }
      ctx.json(200, { ok: true, per: getDerived() });
    },
  },
  {
    method: "GET",
    path: "/api/credits",
    handler: async (ctx) => {
      const key = ctx.url.searchParams.get("account") || "";
      const accounts = loadAccounts();
      const a = findAccount(accounts, key);
      if (!a) return ctx.json(404, { ok: false, error: "账号不存在" });
      const r = await fetchOneAccount(a);
      saveAccounts(accounts);
      ctx.json(
        r.data
          ? 200
          : 200,
        r.data
          ? { ok: true, account: brief(a), summary: r.summary, data: r.data, fetchedAt: cnNow() }
          : { ok: false, error: r.error, expired: r.expired, account: brief(a) }
      );
    },
  },
  {
    method: "GET",
    path: "/api/export.md",
    handler: async (ctx) => {
      const results = await fetchAllAccounts();
      const name = "workbuddy-report-" + new Date().toISOString().slice(0, 10) + ".md";
      ctx.respondRaw(
        200,
        { "Content-Type": "text/markdown; charset=utf-8", "Content-Disposition": `attachment; filename="${name}"` },
        mdAll(results)
      );
    },
  },
  {
    method: "GET",
    path: "/api/webdav/config",
    handler: (ctx) => {
      const c = loadSyncConfig();
      ctx.json(200, { ok: true, has: !!c, url: c ? c.url : "", user: c ? c.user : "" }); // 不返回密码明文
    },
  },
  {
    method: "GET",
    path: "/api/scheduler/status",
    handler: (ctx) => ctx.json(200, { ok: true, scheduler: getSchedulerStatus() }),
  },

  // ---------- 写接口（admin:true，分发层统一鉴权） ----------
  {
    method: "POST",
    path: "/api/save-current",
    admin: true,
    handler: async (ctx) => {
      const { account } = await saveCurrentFromEdge();
      broadcastRefresh({ source: "save-current" });
      ctx.json(200, { ok: true, account: brief(account) });
    },
  },
  {
    method: "POST",
    path: "/api/rename",
    admin: true,
    handler: (ctx) => {
      const { key, name } = ctx.bodyObj;
      const accounts = loadAccounts();
      const t = findAccount(accounts, key);
      if (!t) return ctx.json(404, { ok: false, error: "账号不存在" });
      t.displayName = String(name || "").trim();
      saveAccounts(accounts);
      ctx.json(200, { ok: true, account: brief(t) });
    },
  },
  {
    method: "POST",
    path: "/api/del",
    admin: true,
    handler: (ctx) => {
      const { key } = ctx.bodyObj;
      const accounts = loadAccounts();
      const t = findAccount(accounts, key);
      if (!t) return ctx.json(404, { ok: false, error: "账号不存在" });
      accounts.splice(accounts.indexOf(t), 1);
      saveAccounts(accounts);
      ctx.json(200, { ok: true });
    },
  },
  {
    method: "POST",
    path: "/api/reorder",
    admin: true,
    handler: (ctx) => {
      const { ids } = ctx.bodyObj;
      if (!Array.isArray(ids) || !ids.length) return ctx.json(400, { ok: false, error: "ids 为空" });
      const accounts = loadAccounts();
      const byId = new Map(accounts.map((a) => [a.id, a]));
      const reordered = [];
      for (const id of ids) {
        const a = byId.get(id);
        if (a) reordered.push(a);
      }
      for (const a of accounts) if (!reordered.includes(a)) reordered.push(a); // 容错：未提及的追加末尾
      saveAccounts(reordered);
      ctx.json(200, { ok: true, total: reordered.length });
    },
  },
  {
    method: "POST",
    path: "/api/clear-data",
    admin: true,
    handler: (ctx) => {
      const { accounts, history, cache } = ctx.bodyObj;
      const cleared = [];
      if (accounts) {
        clearAccounts();
        fs.rmSync(ACCOUNTS_FILE, { force: true }); // 同步清理遗留镜像
        cleared.push("账号池");
      }
      if (history) {
        clearReadings();
        fs.rmSync(path.join(TOOLS_DIR, "wb-history.json"), { force: true });
        cleared.push("历史快照");
      }
      if (cache) {
        fs.rmSync(LAST_FILE, { force: true });
        cleared.push("最近缓存");
      }
      ctx.json(200, { ok: true, cleared });
    },
  },
  {
    method: "POST",
    path: "/api/webdav/config",
    admin: true,
    handler: (ctx) => {
      const { url, user, pass } = ctx.bodyObj;
      const u = String(url || "").trim();
      if (u && !/^https?:\/\//.test(u)) return ctx.json(400, { ok: false, error: "地址需以 http(s):// 开头" });
      // 密码留空时不覆盖已保存的密码（避免打开弹窗未重输密码就保存导致密码被清空、登录失败）
      const existing = loadSyncConfig() || {};
      const newPass = pass ? String(pass) : (existing.pass || "");
      saveSyncConfig({ url: u, user: String(user || "").trim(), pass: newPass });
      ctx.json(200, { ok: true });
    },
  },
  {
    method: "POST",
    path: "/api/webdav/test",
    admin: true,
    handler: async (ctx) => {
      const c = syncCfg();
      await testConnection(c.url, c.user, c.pass);
      ctx.json(200, { ok: true, message: "连接成功,目录可用" });
    },
  },
  {
    method: "POST",
    path: "/api/webdav/upload",
    admin: true,
    handler: async (ctx) => {
      const c = syncCfg();
      exportAccounts(); // 先把 SQLite 账号池导出为镜像文件(wb-accounts.json)
      exportHistory(); // 再把 readings 导出为镜像文件(wb-history.json)
      const uploaded = [];
      for (const f of SYNC_FILES) {
        const p = path.join(TOOLS_DIR, f);
        if (!fs.existsSync(p)) continue;
        await uploadFile(c.url, c.user, c.pass, BACKUP_DIR, f, fs.readFileSync(p));
        uploaded.push(f);
      }
      if (!uploaded.length)
        return ctx.json(200, { ok: true, uploaded: [], message: "没有可上传的数据文件(先刷新一次生成数据)" });
      ctx.json(200, { ok: true, uploaded, message: `已上传 ${uploaded.length} 个文件到 ${BACKUP_DIR}/` });
    },
  },
  {
    method: "POST",
    path: "/api/webdav/download",
    admin: true,
    handler: async (ctx) => {
      const c = syncCfg();
      const restored = [];
      for (const f of SYNC_FILES) {
        const content = await downloadFile(c.url, c.user, c.pass, BACKUP_DIR, f);
        if (content === null) continue;
        fs.writeFileSync(path.join(TOOLS_DIR, f), content, "utf8");
        restored.push(f);
      }
      if (!restored.length)
        return ctx.json(200, { ok: true, restored: [], message: "云端没有备份文件(先在其他电脑上传一次)" });
      importAccounts(); // 下载后把账号池镜像导入 SQLite（新的唯一真相源）
      importHistory();
      broadcastRefresh({ source: "webdav-download" });
      ctx.json(200, { ok: true, restored, message: `已下载 ${restored.length} 个文件并覆盖本地,请刷新查看` });
    },
  },
  {
    method: "POST",
    path: "/api/webdav/clear",
    admin: true,
    handler: (ctx) => {
      fs.rmSync(SYNC_FILE, { force: true });
      ctx.json(200, { ok: true, message: "已清空云端配置" });
    },
  },
  {
    // 采样手动触发：不要求管理员（只读采样，且前端主动触发，无副作用风险）
    method: "POST",
    path: "/api/scheduler/run",
    handler: async (ctx) => {
      const r = await runSchedulerNow(); // 采样内部已通过 notifier 广播 refresh,此处不再重复推送
      ctx.json(200, { ok: true, ...r });
    },
  },
  {
    method: "POST",
    path: "/api/scheduler/set",
    admin: true,
    handler: (ctx) => {
      const { enabled, intervalMin } = ctx.bodyObj;
      if (enabled === false) stopScheduler();
      else startScheduler(intervalMin ? { intervalMin } : {});
      ctx.json(200, { ok: true, scheduler: getSchedulerStatus() });
    },
  },
];

// ==================== HTTP 服务（分发层） ====================
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  // 允许跨域（演示预览页/其他端口也能请求本服务）
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Admin-Token, Authorization");
  if (req.method === "OPTIONS") return res.end("ok");

  // 请求上下文：handler 通过 ctx.json / ctx.respondRaw 回写；responded 防重复写
  const ctx = { req, url, res, responded: false };
  ctx.json = (code, obj) => {
    if (ctx.responded) return;
    ctx.responded = true;
    res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(obj));
  };
  ctx.respondRaw = (code, headers, content) => {
    if (ctx.responded) return;
    ctx.responded = true;
    res.writeHead(code, headers);
    res.end(content);
  };

  // 解析请求体（POST/PUT 一次性解析，handler 与鉴权共用，避免重复读流）
  let rawBody = "";
  if (req.method === "POST" || req.method === "PUT") {
    try {
      rawBody = await readBody(req);
    } catch (e) {
      return ctx.json(400, { ok: false, error: e.message });
    }
    try {
      ctx.bodyObj = rawBody ? JSON.parse(rawBody) : {};
    } catch {
      return ctx.json(400, { ok: false, error: "请求体 JSON 解析失败" });
    }
  } else {
    ctx.bodyObj = {};
  }

  // 路由匹配（method + path 精确）
  const route = routes.find((r) => r.method === req.method && r.path === url.pathname);
  if (!route) return ctx.json(404, { ok: false, error: "not found" });

  // 管理员鉴权（统一在分发层）；未设置密码(adminPass 为空)时开放
  if (route.admin && adminDenied(ctx)) {
    return ctx.json(401, { ok: false, error: "需要管理员密码", needAuth: true });
  }

  try {
    await route.handler(ctx);
  } catch (e) {
    if (!ctx.responded) ctx.json(500, { ok: false, error: e.message });
  }
});

function listen(port, max) {
  server.once("error", (err) => {
    if (err.code === "EADDRINUSE" && port < max) listen(port + 1, max);
    else {
      console.error("端口 " + port + " 启动失败: " + err.message);
      process.exit(1);
    }
  });
  server.listen(port, "127.0.0.1", () => {
    const addr = `http://127.0.0.1:${port}`;
    console.log("WorkBuddy 积分仪表盘已启动: " + addr);
    // 仅 Windows 桌面场景自动打开浏览器；Linux/Docker 下不执行
    if (process.platform === "win32") {
      try {
        const child = spawn("cmd", ["/c", "start", "", addr], { detached: true, stdio: "ignore" });
        child.on("error", () => {});
        child.unref();
      } catch {}
    }
    // Docker/NAS 方案：启动时尝试从 WebDAV 同步账号池（失败不致命）
    if (collectorStatus().scheme === "file") {
      syncFromWebDAV()
        .then((r) => console.log(`[启动] 已从 WebDAV 同步 ${r.count} 个数据文件`))
        .catch((e) => console.log("[启动] WebDAV 同步跳过: " + e.message));
    }
    // P1：启动采样调度器（不依赖 daemon，任何部署方案都启用；新数据经 SSE 推送）
    setSchedulerNotifier((meta) => broadcastRefresh(meta));
    startScheduler();
    console.log("[启动] 采样调度器已启动（后台周期采集,实时推送）");
  });
}

const basePort = parseInt(process.argv[2] || String(GUI_PORT), 10) || GUI_PORT;
listen(basePort, basePort + 20); // 被占用时最多顺延 20 个端口
