/**
 * wb-credits-capture - 积分账号抓取器
 *
 * 职责(极简,只服务 wb-credits-tool):
 *  1. capture: 读当前登录的 workbuddy.cn 登录 Cookie(chrome.cookies 官方 API,含 HttpOnly)
 *     → 请求 billing API 验证 + 拿 Uin(带 Cookie 头,扩展 fetch 不走网页上下文,必须手动拼)
 *  2. sync:    拉远端 wb-accounts.json(工具 BACKUP_DIR 固定路径)→ 按 Uin 合并当前账号(其余保留)
 *     → 上传全量。工具「一键同步」再从同一路径拉取并导入 SQLite。
 *
 * 目录约定(与 wb-credits-tool src/compute/webdav.js 保持一致):
 *   远端路径: {base}/workbuddy/workbuddy积分/wb-accounts.json
 *   默认 base: http://192.168.2.1:6086
 */
const API = "https://www.workbuddy.cn/billing/meter/get-user-resource";
const REFERER = "https://www.workbuddy.cn/profile/plans-usage";
const DEFAULT_WEBDAV_URL = "http://192.168.2.1:6086";
const BACKUP_DIR = "workbuddy/workbuddy积分"; // 与工具 BACKUP_DIR 完全一致
const ACCOUNTS_FILE = "wb-accounts.json";
const CFG_KEY = "wb_credits_capture_webdav";
const CACHE_KEY = "wb_credits_capture_cache"; // 最近一次抓取结果(展示用,非真相)

// ============================================================
//  配置
// ============================================================
async function getConfig() {
  const r = await chrome.storage.local.get(CFG_KEY);
  const cfg = r[CFG_KEY] || {};
  return {
    url: String(cfg.url || "").trim() || DEFAULT_WEBDAV_URL,
    user: String(cfg.user || ""),
    pass: String(cfg.pass || ""),
  };
}

// ============================================================
//  抓取:读 Cookie → 验证 → 组装账号记录
// ============================================================
async function capture() {
  const url = "https://www.workbuddy.cn/";
  const cookies = await chrome.cookies.getAll({ url });
  if (!cookies.length) throw new Error("未获取到 workbuddy.cn 的 Cookie(未登录或未授予站点权限)");
  const filtered = cookies.filter((c) => c.domain.includes("workbuddy.cn"));
  if (!filtered.length) throw new Error("未找到 workbuddy.cn 登录 Cookie");
  const cookieHeader = filtered.map((c) => `${c.name}=${c.value}`).join("; ");

  // 验证 + 拿 Uin(与工具 client.js 同款请求;扩展 fetch 带浏览器 UA/TLS,不受 UA 风控)
  const resp = await fetch(API, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: cookieHeader,
      Referer: REFERER,
    },
    body: "{}",
  });
  if (resp.status === 401 || resp.status === 403)
    throw new Error(`Cookie 无效(HTTP ${resp.status}),请确认已在浏览器登录 workbuddy.cn`);
  let j;
  try { j = await resp.json(); } catch {
    throw new Error("billing 接口响应异常,可能官方接口变更(HTTP " + resp.status + ")");
  }
  if (j.code !== 0) throw new Error("billing 接口错误: " + (j.msg || JSON.stringify(j).slice(0, 120)));
  const data = (j.data && j.data.Response && j.data.Response.Data) || {};
  const first = (data.Accounts && data.Accounts[0]) || {};
  const uin = String(first.Uin || "");
  if (!uin) throw new Error("billing 响应中未找到账号标识(Uin)");

  const now = new Date().toISOString();
  const rec = {
    id: null, // 合并时决定(已有保留,新增生成)
    name: "账号" + uin.slice(-4),
    uin,
    cookieHeader,
    userAgent: navigator.userAgent || "",
    sessionExpiresAt: minSessionExpiry(filtered),
    displayName: "",
    lastStatus: "ok",
    source: "extension",
    addedAt: now,
    updatedAt: now,
  };
  await chrome.storage.local.set({ [CACHE_KEY]: { account: rec, capturedAt: now, total: data.TotalCount, dosage: data.TotalDosage } });
  return { rec, total: data.TotalCount, dosage: data.TotalDosage };
}

/** session cookie 的最早过期时间(秒 → ISO);无则 null(与工具 edge-collector 的 minSessionExpiry 同口径) */
function minSessionExpiry(cookies) {
  const exps = cookies
    .filter((c) => /session/i.test(c.name) && c.expires && c.expires > 0)
    .map((c) => c.expires);
  return exps.length ? new Date(Math.min(...exps) * 1000).toISOString() : null;
}

// ============================================================
//  WebDAV 协议(参考 Cookie Switcher lib/webdav.js 精简)
// ============================================================
function basicAuth(user, pass) {
  return "Basic " + btoa(unescape(encodeURIComponent(`${user}:${pass}`)));
}
async function dav(method, u, cfg, body, headers = {}) {
  const r = await fetch(u, {
    method,
    headers: { Authorization: basicAuth(cfg.user, cfg.pass), ...headers },
    body: body || undefined,
  });
  if (r.status === 401 || r.status === 403) throw new Error("WebDAV 认证失败:用户名或密码错误");
  return r;
}
function dirUrl(cfg) {
  const base = cfg.url.replace(/\/+$/, "");
  return `${base}/${BACKUP_DIR.split("/").map(encodeURIComponent).join("/")}`;
}
async function ensureDir(cfg) {
  const base = cfg.url.replace(/\/+$/, "");
  const dir = dirUrl(cfg);
  for (const level of [base + "/workbuddy", dir]) {
    const probe = await dav("PROPFIND", level, cfg, undefined, { Depth: "0" });
    if (probe.status !== 404) continue;
    const mk = await dav("MKCOL", level, cfg);
    if (mk.status !== 201 && mk.status !== 405) throw new Error("创建 WebDAV 目录失败:HTTP " + mk.status);
  }
}
async function fetchRemote(cfg) {
  const u = dirUrl(cfg) + "/" + ACCOUNTS_FILE;
  const r = await dav("GET", u, cfg);
  if (r.status === 404) return null;
  if (!r.ok) throw new Error("下载 wb-accounts.json 失败:HTTP " + r.status);
  return r.text();
}
async function pushRemote(cfg, content) {
  const u = dirUrl(cfg) + "/" + ACCOUNTS_FILE;
  const r = await dav("PUT", u, cfg, content, { "Content-Type": "application/json" });
  if (![200, 201, 204].includes(r.status)) throw new Error("上传失败:HTTP " + r.status);
}

// ============================================================
//  同步:拉远端 → 按 Uin 合并当前账号 → 上传全量
// ============================================================
async function syncNow(rec) {
  const cfg = await getConfig();
  if (!cfg.user) throw new Error("未配置 WebDAV 账号,请先在弹窗填写用户名/密码");

  // 拉远端(不存在=首次,从空开始)
  let remote = { updatedAt: new Date().toISOString(), accounts: [], tombstones: [] };
  const raw = await fetchRemote(cfg);
  if (raw !== null) {
    try { remote = JSON.parse(raw); } catch { /* 远端损坏:从空开始,覆盖修复 */ }
    if (!Array.isArray(remote.accounts)) remote.accounts = [];
    if (!Array.isArray(remote.tombstones)) remote.tombstones = [];
  }

  // 按 Uin 合并当前账号(参考工具 mergeAccountsSmart:updatedAt 新 1s+ 覆盖)
  const key = String(rec.uin);
  const ex = remote.accounts.find((a) => a && String(a.uin) === key);
  if (ex) {
    Object.assign(ex, rec, { id: ex.id || genId() }); // 保留远端 id;补齐 id
  } else {
    remote.accounts.push({ ...rec, id: genId() });
  }
  remote.updatedAt = new Date().toISOString();

  // 上传全量(覆盖式,远端只保留这份 wb-accounts.json)
  await ensureDir(cfg);
  await pushRemote(cfg, JSON.stringify(remote, null, 2));
  return {
    ok: true,
    totalAccounts: remote.accounts.length,
    merged: !!ex ? "更新" : "新增",
    url: dirUrl(cfg) + "/" + ACCOUNTS_FILE,
  };
}

function genId() {
  return "acc" + Math.random().toString(36).slice(2, 10);
}

// ============================================================
//  消息路由(popup → background)
// ============================================================
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    switch (msg && msg.action) {
      case "capture": {
        const r = await capture();
        sendResponse({ ok: true, ...r });
        break;
      }
      case "sync": {
        // 需要先有抓取结果;没有则现抓
        let rec = msg.rec;
        if (!rec) {
          const r = await capture();
          rec = r.rec;
        }
        const out = await syncNow(rec);
        sendResponse({ ok: true, ...out });
        break;
      }
      case "test": {
        const cfg = await getConfig();
        if (!cfg.user) throw new Error("未配置 WebDAV 账号");
        await ensureDir(cfg);
        sendResponse({ ok: true, url: dirUrl(cfg) });
        break;
      }
      case "getState": {
        const c = await chrome.storage.local.get([CFG_KEY, CACHE_KEY]);
        sendResponse({ ok: true, config: c[CFG_KEY] || {}, cache: c[CACHE_KEY] || null });
        break;
      }
      case "saveConfig": {
        const { url, user, pass } = msg;
        await chrome.storage.local.set({
          [CFG_KEY]: { url: String(url || ""), user: String(user || ""), pass: String(pass || "") },
        });
        sendResponse({ ok: true });
        break;
      }
      default:
        sendResponse({ ok: false, error: "unknown action" });
    }
  })().catch((e) => sendResponse({ ok: false, error: e.message }));
  return true; // 异步响应
});
