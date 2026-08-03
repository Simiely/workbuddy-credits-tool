// wb-gui.mjs - WorkBuddy 积分仪表盘 GUI 服务
// 职责:本地 HTTP 服务 + API 路由;查询/渲染走 lib/query、lib/render
// 启动:node wb-gui.mjs [端口],默认 8080,被占用自动顺延(≤8090)
// 双击 wb-gui.bat 启动,关闭命令行窗口即退出
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { TOOLS_DIR, DAEMON_PORT, GUI_PORT } from "./lib/util.js";
import { loadAccounts, saveAccounts, findAccount, ACCOUNTS_FILE } from "./lib/accounts.js";
import { fetchAllAccounts, fetchOneAccount } from "./lib/query.js";
import { saveCurrentFromEdge } from "./lib/account-ops.js";
import { brief, mdAll } from "./lib/render.js";
import { saveLastData, loadLastData, appendSnapshot, historyFor, loadHistory } from "./lib/history.js";
import { loadSyncConfig, saveSyncConfig, uploadFile, downloadFile, testConnection, BACKUP_DIR, SYNC_FILES, SYNC_FILE } from "./lib/webdav.js";

const HTML_FILE = path.join(TOOLS_DIR, "wb-gui.html");
const JS_FILE = path.join(TOOLS_DIR, "wb-gui.js");
const DAEMON_BASE = `http://127.0.0.1:${DAEMON_PORT}`;

// dashboard/all 内存缓存 {mtime, payload}
let dashCache = null;

// ---------- HTTP 服务 ----------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  const json = (code, obj) => { res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" }); res.end(JSON.stringify(obj)); };
  const body = () => new Promise((resolve, reject) => {
    let s = ""; let size = 0;
    req.on("data", (c) => { s += c; size += c.length; if (size > 1024 * 1024) { reject(new Error("请求体过大")); req.destroy(); } });
    req.on("end", () => resolve(s));
    req.on("error", reject);
  });
  try {
    // 允许跨域(演示预览页/其他端口也能请求本服务)
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    if (req.method === "OPTIONS") return res.end("ok"); // 预检直接放行

    // 页面文件:每次实时读取,改前端无需重启服务;禁用缓存避免旧 JS
    if (url.pathname === "/") { res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" }); return res.end(fs.existsSync(HTML_FILE) ? fs.readFileSync(HTML_FILE, "utf8") : "<h1>wb-gui.html 缺失</h1>"); }
    if (url.pathname === "/wb-gui.js") { res.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "no-store" }); return res.end(fs.existsSync(JS_FILE) ? fs.readFileSync(JS_FILE, "utf8") : "// missing"); }

    // 运行状态:edge-daemon 是否在线(添加账号依赖它,查询不依赖)
    if (url.pathname === "/api/status") {
      let daemon = "down";
      try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 2500);
        const r = await fetch(`${DAEMON_BASE}/status`, { signal: ctrl.signal });
        const j = await r.json();
        clearTimeout(t);
        daemon = j.connected ? "ok" : "down";
      } catch {}
      return json(200, { ok: true, daemon });
    }

    // 页面/数据 API
    if (url.pathname === "/api/accounts") {
      const accounts = loadAccounts().map((a) => ({ id: a.id, name: a.name, displayName: a.displayName, uin: a.uin, lastStatus: a.lastStatus, sessionExpiresAt: a.sessionExpiresAt }));
      return json(200, { ok: true, accounts });
    }
    if (url.pathname === "/api/all") {
      const raw = await fetchAllAccounts();
      const results = raw.map((r) => ({ account: brief(r.account), summary: r.summary, data: r.data, error: r.error, expired: r.expired }));
      const payload = { ok: true, fetchedAt: new Date().toLocaleString("zh-CN"), results };
      // 本地缓存(完整数据,离线可看)+ 历史快照(消耗跟踪)—— 异步落盘,不阻塞响应
      saveLastData({ fetchedAt: payload.fetchedAt, results });
      const entries = results.filter((r) => r.summary).map((r) => ({
        uin: r.account.uin, name: r.account.name, displayName: r.account.displayName,
        baseRemain: r.summary.baseRemain, baseUsed: r.summary.baseUsed,
        giftUsed: r.summary.giftUsed, giftRemain: r.summary.giftRemain,
      }));
      if (entries.length) appendSnapshot(entries);
      return json(200, payload);
    }
    // 本地缓存(上次成功查询的完整数据)
    if (url.pathname === "/api/last") {
      const last = loadLastData();
      return last ? json(200, { ok: true, ...last }) : json(200, { ok: false, error: "暂无本地缓存,刷新一次后生成" });
    }
    // 某账号的消耗历史
    if (url.pathname === "/api/history") {
      const key = url.searchParams.get("account") || "";
      const accounts = loadAccounts();
      const a = findAccount(accounts, key);
      if (!a) return json(404, { ok: false, error: "账号不存在" });
      const hist = historyFor(a.uin).slice(-30); // 最近 30 条
      return json(200, { ok: true, account: brief(a), history: hist });
    }
    // 全部账号消耗仪表盘:总趋势 + 每账号当前状态
    // 内存缓存:按 wb-history.json 的 mtime 失效(快照不变则结果不变,避免每次全量解析)
    if (url.pathname === "/api/dashboard/all") {
      const histMtime = fs.existsSync(path.join(TOOLS_DIR, "wb-history.json"))
        ? fs.statSync(path.join(TOOLS_DIR, "wb-history.json")).mtimeMs : 0;
      // 缓存键 = 历史文件 mtime + 本地日期:跨午夜后即使历史未变(今天无新快照)也要重算 todayUsed
      const cacheKey = histMtime + "|" + new Date().toDateString();
      if (dashCache && dashCache.key === cacheKey) {
        return json(200, { ok: true, ...dashCache.payload });
      }
      const hist = loadHistory();
      const accounts = loadAccounts();
      // 按账号分组历史(一次性遍历)
      const byUin = new Map();
      for (const s of hist) {
        for (const e of s.entries) {
          if (!byUin.has(e.uin)) byUin.set(e.uin, []);
          byUin.get(e.uin).push({ ts: s.ts, giftRemain: e.giftRemain, giftUsed: e.giftUsed, baseRemain: e.baseRemain, baseUsed: e.baseUsed });
        }
      }
      const per = accounts.map((a) => {
        const arr = byUin.get(a.uin) || [];
        const first = arr[0], last = arr[arr.length - 1];
        const rem = (x) => (x ? (x.giftRemain || 0) + (x.baseRemain || 0) : 0); // 总剩余
        const usd = (x) => (x ? (x.giftUsed || 0) + (x.baseUsed || 0) : 0);     // 累计已用
        const pad = (n) => String(n).padStart(2, "0");
        // 自然日(本地时区)分组的工具:所有"按天"计算统一走这里,标准唯一
        const dayKey = (t) => { const d = new Date(t); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
        // 按自然日分组剩余序列
        const byDay = new Map();
        for (const x of arr) {
          const k = dayKey(x.ts);
          if (!byDay.has(k)) byDay.set(k, []);
          byDay.get(k).push(x);
        }
        // 每日消耗 = 当天最早剩余 − 当天最晚剩余(自然日,本地时区)
        const series = [...byDay.keys()].sort().map((k) => {
          const pts = byDay.get(k).sort((a, b) => (a.ts < b.ts ? -1 : 1));
          return { t: pts[pts.length - 1].ts, v: Math.round((rem(pts[0]) - rem(pts[pts.length - 1])) * 100) / 100 };
        });
        // 今日消耗 = 今天(自然日)最早剩余 − 最晚剩余;series 里今天的 v 即此值,保持一致
        const todayKey = dayKey(new Date().toISOString());
        const todayPt = series.find((x) => dayKey(x.t) === todayKey);
        const todayUsed = todayPt ? todayPt.v : 0;
        return {
          uin: a.uin, name: a.name, displayName: a.displayName,
          currentRemain: last ? rem(last) : null,
          used: last ? usd(last) : null,
          consumed: arr.length > 1 ? rem(first) - rem(last) : 0,
          todayUsed: todayUsed > 0 ? Math.round(todayUsed * 100) / 100 : 0,
          points: arr.length,
          series, // 每日消耗序列(自然日),前端直接展示不再计算
        };
      });
      dashCache = { key: cacheKey, payload: { per } };
      return json(200, { ok: true, per });
    }
    if (url.pathname === "/api/credits") {
      const key = url.searchParams.get("account") || "";
      const accounts = loadAccounts();
      const a = findAccount(accounts, key);
      if (!a) return json(404, { ok: false, error: "账号不存在" });
      const r = await fetchOneAccount(a);
      saveAccounts(accounts);
      return r.data
        ? json(200, { ok: true, account: brief(a), summary: r.summary, data: r.data, fetchedAt: new Date().toLocaleString("zh-CN") })
        : json(200, { ok: false, error: r.error, expired: r.expired, account: brief(a) });
    }
    if (url.pathname === "/api/save-current" && req.method === "POST") {
      const { account } = await saveCurrentFromEdge();
      return json(200, { ok: true, account: brief(account) });
    }
    if (url.pathname === "/api/rename" && req.method === "POST") {
      const { key, name } = JSON.parse((await body()) || "{}");
      const accounts = loadAccounts();
      const t = findAccount(accounts, key);
      if (!t) return json(404, { ok: false, error: "账号不存在" });
      t.displayName = String(name || "").trim();
      saveAccounts(accounts);
      return json(200, { ok: true, account: brief(t) });
    }
    if (url.pathname === "/api/del" && req.method === "POST") {
      const { key } = JSON.parse((await body()) || "{}");
      const accounts = loadAccounts();
      const t = findAccount(accounts, key);
      if (!t) return json(404, { ok: false, error: "账号不存在" });
      accounts.splice(accounts.indexOf(t), 1);
      saveAccounts(accounts);
      return json(200, { ok: true });
    }
    // 卡片排序:按前端拖拽结果重排账号池数组(顺序随账号池持久化/云同步)
    if (url.pathname === "/api/reorder" && req.method === "POST") {
      const { ids } = JSON.parse((await body()) || "{}");
      if (!Array.isArray(ids) || !ids.length) return json(400, { ok: false, error: "ids 为空" });
      const accounts = loadAccounts();
      const byId = new Map(accounts.map((a) => [a.id, a]));
      const reordered = [];
      for (const id of ids) { const a = byId.get(id); if (a) reordered.push(a); }
      for (const a of accounts) if (!reordered.includes(a)) reordered.push(a); // 容错:未提及的追加末尾
      saveAccounts(reordered);
      return json(200, { ok: true, total: reordered.length });
    }
    // Markdown 报表(按账号分节)
    if (url.pathname === "/api/export.md") {
      const results = await fetchAllAccounts();
      const name = "workbuddy-report-" + new Date().toISOString().slice(0, 10) + ".md";
      res.writeHead(200, { "Content-Type": "text/markdown; charset=utf-8", "Content-Disposition": `attachment; filename="${name}"` });
      return res.end(mdAll(results));
    }
    // 清空本地数据(分项,需显式勾选确认)
    if (url.pathname === "/api/clear-data" && req.method === "POST") {
      const { accounts, history, cache } = JSON.parse((await body()) || "{}");
      const cleared = [];
      if (accounts) { fs.rmSync(ACCOUNTS_FILE, { force: true }); cleared.push("账号池"); }
      if (history) { fs.rmSync(path.join(TOOLS_DIR, "wb-history.json"), { force: true }); cleared.push("历史快照"); }
      if (cache) { fs.rmSync(path.join(TOOLS_DIR, "wb-last-data.json"), { force: true }); cleared.push("最近缓存"); }
      return json(200, { ok: true, cleared });
    }
    // ---------- WebDAV 云同步 ----------
    if (url.pathname === "/api/webdav/config" && req.method === "GET") {
      const c = loadSyncConfig();
      return json(200, { ok: true, has: !!c, url: c ? c.url : "", user: c ? c.user : "" }); // 不返回密码明文
    }
    if (url.pathname === "/api/webdav/config" && req.method === "POST") {
      const { url, user, pass } = JSON.parse((await body()) || "{}");
      const u = String(url || "").trim();
      if (u && !/^https?:\/\//.test(u)) return json(400, { ok: false, error: "地址需以 http(s):// 开头" });
      saveSyncConfig({ url: u, user: String(user || "").trim(), pass: String(pass || "") });
      return json(200, { ok: true });
    }
    const syncCfg = () => { const c = loadSyncConfig(); if (!c || !c.user) throw new Error("未配置 WebDAV 账号,请先填写用户名密码并「保存配置」"); return { ...c, url: c.url || Buffer.from("aHR0cHM6Ly93MmUwYjFkNmF2LmRkbnN0by5jb20v", "base64").toString() }; };
    if (url.pathname === "/api/webdav/test" && req.method === "POST") {
      const c = syncCfg();
      await testConnection(c.url, c.user, c.pass);
      return json(200, { ok: true, message: "连接成功,目录可用" });
    }
    if (url.pathname === "/api/webdav/upload" && req.method === "POST") {
      const c = syncCfg();
      const uploaded = [];
      for (const f of SYNC_FILES) {
        const p = path.join(TOOLS_DIR, f);
        if (!fs.existsSync(p)) continue;
        await uploadFile(c.url, c.user, c.pass, BACKUP_DIR, f, fs.readFileSync(p));
        uploaded.push(f);
      }
      if (!uploaded.length) return json(200, { ok: true, uploaded: [], message: "没有可上传的数据文件(先刷新一次生成数据)" });
      return json(200, { ok: true, uploaded, message: `已上传 ${uploaded.length} 个文件到 ${BACKUP_DIR}/` });
    }
    if (url.pathname === "/api/webdav/download" && req.method === "POST") {
      const c = syncCfg();
      const restored = [];
      for (const f of SYNC_FILES) {
        const content = await downloadFile(c.url, c.user, c.pass, BACKUP_DIR, f);
        if (content === null) continue;
        fs.writeFileSync(path.join(TOOLS_DIR, f), content, "utf8");
        restored.push(f);
      }
      if (!restored.length) return json(200, { ok: true, restored: [], message: "云端没有备份文件(先在其他电脑上传一次)" });
      return json(200, { ok: true, restored, message: `已下载 ${restored.length} 个文件并覆盖本地,请刷新查看` });
    }
    // 清空本地 WebDAV 登录配置
    if (url.pathname === "/api/webdav/clear" && req.method === "POST") {
      fs.rmSync(SYNC_FILE, { force: true });
      return json(200, { ok: true, message: "已清空云端配置" });
    }

    json(404, { ok: false, error: "not found" });
  } catch (e) {
    json(500, { ok: false, error: e.message });
  }
});

function listen(port, max) {
  server.once("error", (err) => {
    if (err.code === "EADDRINUSE" && port < max) listen(port + 1, max);
    else { console.error("端口 " + port + " 启动失败: " + err.message); process.exit(1); }
  });
  server.listen(port, "127.0.0.1", () => {
    const addr = `http://127.0.0.1:${port}`;
    console.log("WorkBuddy 积分仪表盘已启动: " + addr);
    // 仅 Windows 桌面场景自动打开浏览器;Linux/Docker 下不执行(无 cmd 命令,spawn 会崩溃)
    if (process.platform === "win32") {
      try {
        const child = spawn("cmd", ["/c", "start", "", addr], { detached: true, stdio: "ignore" });
        child.on("error", () => {}); // 吞掉 ENOENT 等,防止未处理 error 崩溃
        child.unref();
      } catch {}
    }
  });
}

const basePort = parseInt(process.argv[2] || String(GUI_PORT), 10) || GUI_PORT;
listen(basePort, basePort + 20); // 被占用时最多顺延 20 个端口(旧版写死 8090,8123 永远顺延不了)
