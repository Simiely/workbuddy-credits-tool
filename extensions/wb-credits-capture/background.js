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
 *
 * 注:lib/ 目录保留同名源码供单测引用;扩展运行时用本单文件(MV3 classic service worker,
 *     不依赖 type:module,兼容性最好)。改 background.js 时同步改 lib/ 对应文件。
 */

// ============================================================
//  常量
// ============================================================
const API = "https://www.workbuddy.cn/billing/meter/get-user-resource";
const REFERER = "https://www.workbuddy.cn/profile/plans-usage";
const DEFAULT_WEBDAV_URL = "http://192.168.2.1:6086";
const BACKUP_DIR = "workbuddy/workbuddy积分"; // 与工具 BACKUP_DIR 完全一致
const ACCOUNTS_FILE = "wb-accounts.json";
const CFG_KEY = "wb_credits_capture_webdav";
const ACCOUNTS_KEY = "wb_credits_capture_accounts"; // 全部已抓取账号(卡片展示/同步真相源)
const REMARK_KEY = "wb_credits_capture_remark"; // uin → 备注(用户手动设置,抓取/同步/显示优先用)

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
//  存储层(chrome.storage 读写:配置/备注/账号列表)
// ============================================================
function genId() {
  return "acc" + Math.random().toString(36).slice(2, 10);
}

async function getConfig() {
  const r = await chrome.storage.local.get(CFG_KEY);
  const cfg = r[CFG_KEY] || {};
  return {
    url: String(cfg.url || "").trim() || DEFAULT_WEBDAV_URL,
    user: String(cfg.user || ""),
    pass: String(cfg.pass || ""),
  };
}
async function saveConfig({ url, user, pass }) {
  await chrome.storage.local.set({
    [CFG_KEY]: { url: String(url || ""), user: String(user || ""), pass: String(pass || "") },
  });
}
async function getRawConfig() {
  const r = await chrome.storage.local.get(CFG_KEY);
  return r[CFG_KEY] || {};
}

// ---- 备注(用户为某账号手动设置的 name)持久化到 chrome.storage,按 uin 记录 ----
async function loadRemark(uin) {
  const r = await chrome.storage.local.get(REMARK_KEY);
  const map = r[REMARK_KEY] || {};
  const v = map && map[String(uin)];
  return v ? String(v).trim() : "";
}
async function saveRemark(uin, remark) {
  const r = await chrome.storage.local.get(REMARK_KEY);
  const map = r[REMARK_KEY] || {};
  map[String(uin)] = String(remark || "").trim();
  await chrome.storage.local.set({ [REMARK_KEY]: map });
}

// ---- 全部已抓取账号列表(chrome.storage 持久化;抓取即新增/更新一张卡片) ----
async function loadAccounts() {
  const r = await chrome.storage.local.get(ACCOUNTS_KEY);
  return Array.isArray(r[ACCOUNTS_KEY]) ? r[ACCOUNTS_KEY] : [];
}
async function persistAccounts(arr) {
  await chrome.storage.local.set({ [ACCOUNTS_KEY]: arr });
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
function fileUrl(cfg) {
  return dirUrl(cfg) + "/" + ACCOUNTS_FILE;
}
function dirUrl(cfg) {
  const base = cfg.url.replace(/\/+$/, "");
  // 必须与主控 src/compute/webdav.js 的 fileUrl 完全一致:使用原始中文路径,不 encodeURIComponent。
  return `${base}/${BACKUP_DIR}`;
}
async function ensureDir(cfg) {
  const base = cfg.url.replace(/\/+$/, "");
  const dir = dirUrl(cfg);
  // WebDAV 集合(目录)URL 必须以 / 结尾,否则部分服务器 MKCOL 直接 409/405。
  for (const level of [`${base}/workbuddy/`, `${dir}/`]) {
    const probe = await dav("PROPFIND", level, cfg, undefined, { Depth: "0" });
    if (probe.status !== 404) continue;
    const mk = await dav("MKCOL", level, cfg);
    if (mk.status !== 201 && mk.status !== 405) throw new Error("创建 WebDAV 目录失败:HTTP " + mk.status);
  }
}
async function fetchRemote(cfg) {
  const r = await dav("GET", fileUrl(cfg), cfg);
  if (r.status === 404) return null;
  if (!r.ok) throw new Error("下载 wb-accounts.json 失败:HTTP " + r.status);
  return r.text();
}
async function pushRemote(cfg, content) {
  const r = await dav("PUT", fileUrl(cfg), cfg, content, { "Content-Type": "application/json" });
  if (![200, 201, 204].includes(r.status)) throw new Error("上传失败:HTTP " + r.status);
}
/** 拉取远端账号镜像并归一化结构(损坏则从空重建) */
async function loadRemote(cfg) {
  let remote = { updatedAt: new Date().toISOString(), accounts: [], tombstones: [] };
  const raw = await fetchRemote(cfg);
  if (raw !== null) {
    try { remote = JSON.parse(raw); } catch { /* 远端损坏:从空开始,覆盖修复 */ }
    if (!Array.isArray(remote.accounts)) remote.accounts = [];
    if (!Array.isArray(remote.tombstones)) remote.tombstones = [];
  }
  return remote;
}

// ============================================================
//  同步:拉远端 → 按 Uin 合并本地全部账号 → 上传全量
// ============================================================
async function syncAll(localAccounts) {
  const cfg = await getConfig();
  if (!cfg.user) throw new Error("未配置 WebDAV 账号,请先在弹窗填写用户名/密码");

  const remote = await loadRemote(cfg);

  let merged = 0, added = 0;
  for (const rec of localAccounts || []) {
    if (!rec || !rec.uin) continue;
    const key = String(rec.uin);
    const ex = remote.accounts.find((a) => a && String(a.uin) === key);
    if (ex) {
      // 备注(name):插件本次若手动设置了真实备注(remarkSet),本次为最新 → 用之;
      // 否则若远端已有备注则保留远端,避免被默认名"账号XXXX"覆盖掉用户设置。
      const remoteHasName = !!(ex.name && String(ex.name).trim());
      const name = (rec.remarkSet || !remoteHasName) ? rec.name : ex.name;
      const displayName = ex.displayName || rec.displayName;
      Object.assign(ex, rec, { id: ex.id || genId(), name, displayName });
      merged++;
    } else {
      remote.accounts.push({ ...rec, id: genId() });
      added++;
    }
  }
  remote.updatedAt = new Date().toISOString();

  await ensureDir(cfg);
  await pushRemote(cfg, JSON.stringify(remote, null, 2));
  return { ok: true, totalAccounts: remote.accounts.length, merged, added, url: fileUrl(cfg) };
}

// ============================================================
//  远端删除:按 uin 移除并写墓碑(删除跨设备传播)
// ============================================================
async function deleteRemote(uin) {
  const cfg = await getConfig();
  const out = { removed: false, tombstoned: false };
  if (!cfg.user) return out;
  const remote = await loadRemote(cfg);
  const beforeR = remote.accounts.length;
  remote.accounts = remote.accounts.filter((a) => a && String(a.uin) !== uin);
  remote.tombstones = remote.tombstones.filter((t) => t && String(t.uin) !== uin);
  remote.tombstones.push({ uin, deletedAt: new Date().toISOString() });
  remote.updatedAt = new Date().toISOString();
  await ensureDir(cfg);
  await pushRemote(cfg, JSON.stringify(remote, null, 2));
  out.removed = remote.accounts.length < beforeR;
  out.tombstoned = true;
  return out;
}

// ============================================================
//  抓取:读 Cookie → 验证 → 组装账号记录(支持抓取时填名称作为备注)
// ============================================================
function minSessionExpiry(cookies) {
  const exps = cookies
    .filter((c) => /session/i.test(c.name) && c.expires && c.expires > 0)
    .map((c) => c.expires);
  return exps.length ? new Date(Math.min(...exps) * 1000).toISOString() : null;
}

async function capture(name) {
  const cookies = await chrome.cookies.getAll({ domain: "workbuddy.cn" });
  if (!cookies.length) throw new Error("未获取到 workbuddy.cn 的 Cookie(未登录或未授予站点权限)");
  const filtered = cookies.filter((c) => c.domain.includes("workbuddy.cn"));
  if (!filtered.length) throw new Error("未找到 workbuddy.cn 登录 Cookie");
  const cookieHeader = sanitizeCookieHeader(filtered.map((c) => `${c.name}=${c.value}`).join("; "));

  const resp = await fetch(API, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookieHeader, Referer: REFERER },
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
  const remark = String(name || "").trim() || (await loadRemark(uin));
  const rec = {
    id: null,
    name: remark || "账号" + uin.slice(-4),
    remarkSet: !!remark,
    uin,
    cookieHeader,
    userAgent: navigator.userAgent || "",
    sessionExpiresAt: minSessionExpiry(filtered),
    displayName: "",
    lastStatus: "ok",
    source: "extension",
    addedAt: now,
    updatedAt: now,
    lastTotal: data.TotalCount,
    lastDosage: data.TotalDosage,
    capturedAt: now,
  };
  if (remark) await saveRemark(uin, remark);
  const accounts = await loadAccounts();
  const idx = accounts.findIndex((a) => a && String(a.uin) === uin);
  if (idx >= 0) accounts[idx] = { ...accounts[idx], ...rec, id: accounts[idx].id };
  else accounts.push(rec);
  await persistAccounts(accounts);
  return { rec, total: data.TotalCount, dosage: data.TotalDosage, accounts };
}

// ============================================================
//  备注设置(为指定 uin 设置 name,持久化并按 uin 更新卡片账号)
// ============================================================
async function setRemark(uin, remark) {
  uin = String(uin || "");
  if (!uin) throw new Error("缺少账号标识(uin)");
  const text = String(remark || "").trim();
  await saveRemark(uin, text);
  const accounts = await loadAccounts();
  const a = accounts.find((x) => x && String(x.uin) === uin);
  const name = text || "账号" + uin.slice(-4);
  if (a) {
    a.name = name;
    a.remarkSet = !!text;
    await persistAccounts(accounts);
  }
  return { ok: true, uin, name };
}

// ---- 一键清理:清空本地全部抓取账号(不动 WebDAV 云端) ----
async function clearAll() {
  const accounts = await loadAccounts();
  await persistAccounts([]);
  return { ok: true, cleared: accounts.length };
}

// ============================================================
//  消息路由(popup → background)
// ============================================================
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    switch (msg && msg.action) {
      case "capture": {
        const r = await capture(msg.name);
        sendResponse({ ok: true, ...r });
        break;
      }
      case "sync": {
        const accounts = await loadAccounts();
        if (!accounts.some((a) => a && a.uin)) throw new Error("还没有抓取过账号,请先点「抓取账号」生成卡片");
        sendResponse({ ok: true, ...(await syncAll(accounts)) });
        break;
      }
      case "setRemark": {
        sendResponse(await setRemark(msg.uin, msg.remark));
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
        sendResponse({ ok: true, config: await getRawConfig(), accounts: await loadAccounts() });
        break;
      }
      case "export": {
        const accounts = await loadAccounts();
        const payload = { updatedAt: new Date().toISOString(), accounts, tombstones: [] };
        sendResponse({ ok: true, json: JSON.stringify(payload, null, 2), count: accounts.length });
        break;
      }
      case "deleteCapture": {
        const uin = String(msg.uin || "");
        const accounts = await loadAccounts();
        const before = accounts.length;
        const kept = accounts.filter((a) => a && String(a.uin) !== uin);
        const existed = kept.length < before;
        await persistAccounts(kept);
        let webdav = { removed: false, tombstoned: false };
        const cfg = await getConfig();
        if (cfg.user) {
          try { webdav = await deleteRemote(uin); } catch (e) { webdav = { ...webdav, error: e.message }; }
        }
        sendResponse({ ok: true, uin, existed, webdav });
        break;
      }
      case "clearAll": {
        sendResponse(await clearAll());
        break;
      }
      case "saveConfig": {
        await saveConfig({ url: msg.url, user: msg.user, pass: msg.pass });
        sendResponse({ ok: true });
        break;
      }
      default:
        sendResponse({ ok: false, error: "unknown action" });
    }
  })().catch((e) => sendResponse({ ok: false, error: e.message }));
  return true; // 异步响应
});
