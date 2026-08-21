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
//  Cookie 清洗(对齐工具 src/compute/client.js sanitizeCookieHeader)
//  背景:workbuddy.cn 登录会残留 KC_RESTART(1KB+ 一次性令牌)/埋点追踪 cookie,
//  多次登录还会残留同名多份,header 总长可超 7KB → 网关 400 Cookie Too Large。
//  扩展自己发 billing 验证请求 + 落库 WebDAV 前都必须清洗,否则扩展内验证直接 400。
// ============================================================
const JUNK_COOKIE_PREFIX = [
  "KC_RESTART",       // Keycloak 登录重启令牌(一次性,API 不需要,1KB+)
  "KC_STATE_CHECKER", // Keycloak 状态校验(登录流程用)
  "9c412d6095037d16", // 风控指纹
  "_TDID_CK",         // 腾讯 TDID 跟踪
  "_gcl_au",          // Google 广告
  "trafficParams",    // 流量参数
  "sensorsdata",      // 神策埋点
  "qcloud_",          // 腾讯云埋点(qcloud_from/qcloud_visitId)
  "i18next",          // 国际化语言偏好
  "login_risk_state", // 登录风控状态
];
const AUTH_COOKIE_WHITELIST = [
  "KEYCLOAK_IDENTITY",
  "KEYCLOAK_SESSION",
  "AUTH_SESSION_ID",
  "session",
  "session_2",
];
const MAX_COOKIE_BYTES = 7000; // stgw 网关请求头约 8KB 上限,留 1KB 余量
function sanitizeCookieHeader(cookieHeader) {
  if (!cookieHeader || typeof cookieHeader !== "string") return cookieHeader;
  const parts = cookieHeader.split(";").map((s) => s.trim()).filter(Boolean);
  if (!parts.length) return cookieHeader;
  const byName = new Map();
  for (const p of parts) {
    const eq = p.indexOf("=");
    const name = eq > 0 ? p.slice(0, eq) : p;
    if (JUNK_COOKIE_PREFIX.some((j) => name.startsWith(j))) continue; // 剔除垃圾
    byName.set(name, p); // 同名保留最后一份
  }
  let cleaned = [...byName.values()].join("; ");
  if (cleaned.length > MAX_COOKIE_BYTES) {
    // 超长兜底:只留认证核心白名单
    cleaned = [...byName.values()]
      .filter((p) => AUTH_COOKIE_WHITELIST.some((n) => p.startsWith(n + "=")))
      .join("; ");
  }
  return cleaned;
}

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
  // 全域名树采集(对齐工具 edge-collector 的 domain.includes 口径):
  // 覆盖 .workbuddy.cn / www.workbuddy.cn / host-only workbuddy.cn,避免漏采
  const cookies = await chrome.cookies.getAll({ domain: "workbuddy.cn" });
  if (!cookies.length) throw new Error("未获取到 workbuddy.cn 的 Cookie(未登录或未授予站点权限)");
  const filtered = cookies.filter((c) => c.domain.includes("workbuddy.cn"));
  if (!filtered.length) throw new Error("未找到 workbuddy.cn 登录 Cookie");
  // 清洗:剔除一次性登录/埋点垃圾 cookie + 同名去重 + 超长降级白名单(对齐工具 client.js)
  // 验证请求与落库前都必须是清洗后的 header,否则扩展内验证直接撞 400 Cookie Too Large
  const cookieHeader = sanitizeCookieHeader(filtered.map((c) => `${c.name}=${c.value}`).join("; "));

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
  // 必须与主控 src/compute/webdav.js 的 fileUrl 完全一致:使用原始中文路径,不 encodeURIComponent。
  // (多数 NAS 会解码碰巧可用,但不解码的服务器会让工具「同步」拉到 404 → 当首次同步清空云端)
  return `${base}/${BACKUP_DIR}`;
}
async function ensureDir(cfg) {
  const base = cfg.url.replace(/\/+$/, "");
  const dir = dirUrl(cfg);
  // 注意:WebDAV 集合(目录)URL 必须以 / 结尾,与主控 webdav.js ensureDir 的 `${acc}/` 一致。
  // 部分服务器(Nginx WebDAV / 某些 NAS 如 iStoreOS)对无尾斜杠的 MKCOL 直接 409/405,
  // 导致建目录失败、同步卡死 —— 这是「改过很多轮都同步不上」的典型诱因之一。
  for (const level of [`${base}/workbuddy/`, `${dir}/`]) {
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
      case "export": {
        // 导出当前抓取结果为标准 wb-accounts.json(与 WebDAV 镜像同格式),
        // 供"文件导入"路径:用户下载后交给 WorkBuddy 直接灌入积分仪表盘服务器,绕过 WebDAV。
        const c = await chrome.storage.local.get(CACHE_KEY);
        const cache = c[CACHE_KEY];
        if (!cache || !cache.account) throw new Error("还没有抓取数据,请先点「抓取当前账号」");
        const rec = cache.account;
        const payload = {
          updatedAt: new Date().toISOString(),
          accounts: [rec],
          tombstones: [],
        };
        sendResponse({ ok: true, json: JSON.stringify(payload, null, 2), uin: rec.uin });
        break;
      }
      case "deleteCapture": {
        // 删除当前抓取账号:① 清本地缓存(展示消失);② 若已配 WebDAV,把该 uin 从远端移除并加墓碑,
        // 使服务器下次「一键同步」也删除(对齐工具 tombstone 删除传播,避免一同步又回来)。
        // 本地删除永远成功;WebDAV 失败不致命(仅提示手动在服务器删)。
        const c = await chrome.storage.local.get(CACHE_KEY);
        const cache = c[CACHE_KEY];
        if (!cache || !cache.account) throw new Error("还没有抓取数据,无需删除");
        const uin = String(cache.account.uin);
        await chrome.storage.local.remove(CACHE_KEY); // ① 清本地缓存
        const webdav = { removed: false, tombstoned: false };
        const cfg = await getConfig();
        if (cfg.user) {
          try {
            let remote = { updatedAt: new Date().toISOString(), accounts: [], tombstones: [] };
            const raw = await fetchRemote(cfg);
            if (raw !== null) {
              try { remote = JSON.parse(raw); } catch { /* 损坏:从空重建 */ }
              if (!Array.isArray(remote.accounts)) remote.accounts = [];
              if (!Array.isArray(remote.tombstones)) remote.tombstones = [];
            }
            const before = remote.accounts.length;
            remote.accounts = remote.accounts.filter((a) => a && String(a.uin) !== uin);
            remote.tombstones = remote.tombstones.filter((t) => t && String(t.uin) !== uin);
            remote.tombstones.push({ uin, deletedAt: new Date().toISOString() }); // 墓碑:删除跨设备传播
            remote.updatedAt = new Date().toISOString();
            await ensureDir(cfg);
            await pushRemote(cfg, JSON.stringify(remote, null, 2));
            webdav.removed = remote.accounts.length < before;
            webdav.tombstoned = true;
          } catch (e) {
            webdav.error = e.message; // WebDAV 失败不致命,本地缓存已清
          }
        }
        sendResponse({ ok: true, uin, webdav });
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
