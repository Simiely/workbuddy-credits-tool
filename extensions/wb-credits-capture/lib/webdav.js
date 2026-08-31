// lib/webdav.js — WebDAV 协议(参考 Cookie Switcher lib/webdav.js 精简)+ 同步/删除
import { BACKUP_DIR, ACCOUNTS_FILE, genId, getConfig } from "./store.js";

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

export function fileUrl(cfg) {
  return dirUrl(cfg) + "/" + ACCOUNTS_FILE;
}

export function dirUrl(cfg) {
  const base = cfg.url.replace(/\/+$/, "");
  // 必须与主控 src/compute/webdav.js 的 fileUrl 完全一致:使用原始中文路径,不 encodeURIComponent。
  // (多数 NAS 会解码碰巧可用,但不解码的服务器会让工具「同步」拉到 404 → 当首次同步清空云端)
  return `${base}/${BACKUP_DIR}`;
}

export async function ensureDir(cfg) {
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
//  主流程:同步全部(拉远端 → 按 Uin 合并本地全部账号 → 上传全量)
// ============================================================
export async function syncAll(localAccounts) {
  const cfg = await getConfig();
  if (!cfg.user) throw new Error("未配置 WebDAV 账号,请先在弹窗填写用户名/密码");

  const remote = await loadRemote(cfg); // 不存在=首次,从空开始

  // 按 Uin 合并本地全部账号(参考工具 mergeAccountsSmart:updatedAt 新 1s+ 覆盖)
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

  // 上传全量(覆盖式,远端只保留这份 wb-accounts.json)
  await ensureDir(cfg);
  await pushRemote(cfg, JSON.stringify(remote, null, 2));
  return {
    ok: true,
    totalAccounts: remote.accounts.length,
    merged,
    added,
    url: fileUrl(cfg),
  };
}

// ============================================================
//  支流程:按 uin 从远端移除并写墓碑(删除跨设备传播)
// ============================================================
export async function deleteRemote(uin) {
  const cfg = await getConfig();
  const out = { removed: false, tombstoned: false };
  if (!cfg.user) return out; // 未配置 WebDAV:仅本地删除
  const remote = await loadRemote(cfg);
  const beforeR = remote.accounts.length;
  remote.accounts = remote.accounts.filter((a) => a && String(a.uin) !== uin);
  remote.tombstones = remote.tombstones.filter((t) => t && String(t.uin) !== uin);
  remote.tombstones.push({ uin, deletedAt: new Date().toISOString() }); // 墓碑:删除跨设备传播
  remote.updatedAt = new Date().toISOString();
  await ensureDir(cfg);
  await pushRemote(cfg, JSON.stringify(remote, null, 2));
  out.removed = remote.accounts.length < beforeR;
  out.tombstoned = true;
  return out;
}