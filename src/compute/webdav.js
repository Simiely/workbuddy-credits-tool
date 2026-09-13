// src/compute/webdav.js - WebDAV 云同步（数据备份：上传/下载），原 lib/webdav.js
// 将账号池 + 历史快照备份到用户指定的 WebDAV（坚果云/Nextcloud 等）。
// 注:trae-last-data.json(最近一次刷新缓存,展示数据副本)不属于"账本"数据,不参与备份(v1.4.31)。
// v1.4.58：一键同步 syncNow() 从 wb-gui.mjs 路由内嵌搬回（薄路由），依赖 store/history 单向无环。
import fs from "node:fs";
import path from "node:path";
import { TOOLS_DIR, trailSlotRoot } from "../config.js";
import {
  loadAccounts,
  saveAccounts,
  mergeAccountsSmart,
  tombstoneUins,
  loadTombstones,
  purgeOldTombstones,
  reconcileFromDisk,
  exportLegacy as exportAccounts,
} from "./store.js";
import { importLegacy as importHistory, exportLegacy as exportHistory } from "./history.js";
import { SYNC_FILES, HISTORY_FILE, ACCOUNTS_FILE } from "../store/syncbridge.js";
import { rewriteAccountPaths } from "./paths.js";
// 兼容导出：trae-gui 仍从本模块取这两个清单/路径符号；真源已收敛到 syncbridge.js / paths.js
export { ACCOUNTS_FILE, SYNC_FILES, rewriteAccountPaths };

// 与上传/下载同一清单真源解构，避免 syncNow 拉取时写死文件名导致清单漂移
const [ACC_FNAME, HIST_FNAME] = SYNC_FILES;

export const SYNC_FILE = path.join(TOOLS_DIR, "wb-sync.json"); // 本地同步配置（含密码，仅本机）
export const BACKUP_DIR = "workbuddy/workbuddy登录积分/trae积分"; // WebDAV 上的备份目录（多级,与 MultiSwitch 登录态备份同根分类）
// 备份哪些账本文件——清单真源见 ../store/syncbridge.js 的 SYNC_FILES

export function loadSyncConfig() {
  try {
    return JSON.parse(fs.readFileSync(SYNC_FILE, "utf8"));
  } catch {
    return null;
  }
}
export function saveSyncConfig(cfg) {
  fs.writeFileSync(SYNC_FILE, JSON.stringify(cfg, null, 2), "utf8");
}

const auth = (user, pass) => "Basic " + Buffer.from(`${user}:${pass}`).toString("base64");

// 统一请求：网络超时/连接错误自动退避重试 2 次(穿透线路抖动时提高成功率)；登录失败/HTTP 错误不重试
// timeoutMs:小请求(建目录/测试)20s；上传/下载大文件(如 trae-history.json 慢速穿透)给 120s(v1.4.66 由 60s 放宽)
async function req(method, url, user, pass, body, timeoutMs = 20000, extraHeaders = null) {
  for (let attempt = 0; ; attempt++) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const r = await fetch(url, {
        method,
        headers: {
          Authorization: auth(user, pass),
          ...(body ? { "Content-Type": "application/octet-stream" } : {}),
          ...(extraHeaders || {}),
        },
        body,
        signal: ctrl.signal,
      });
      if (r.status === 401 || r.status === 403)
        throw new Error("WebDAV 登录失败：用户名或密码错误（HTTP " + r.status + " 未授权）");
      return r;
    } catch (e) {
      if (e.message.startsWith("WebDAV 登录失败")) throw e;
      const netErr = e.name === "AbortError" || e.message.startsWith("网络错误") || e.message.startsWith("WebDAV 请求超时");
      if (netErr && attempt < 2) {
        await new Promise((res) => setTimeout(res, 800 * (attempt + 1))); // 0.8s / 1.6s 退避
        continue;
      }
      throw new Error(e.name === "AbortError" ? `WebDAV 请求超时(${Math.round(timeoutMs / 1000)}s)` : "网络错误: " + e.message);
    } finally {
      clearTimeout(t);
    }
  }
}

const baseOf = (base) => base.replace(/\/+$/, "");
const fileUrl = (base, dir, file) => `${baseOf(base)}/${dir}/${file}`;

/** 确保备份目录存在：多级目录逐级 MKCOL（每级 201 新建 / 405·301 已存在均视为成功） */
export async function ensureDir(base, user, pass, dir = BACKUP_DIR) {
  const baseUrl = baseOf(base);
  let acc = "";
  for (const seg of String(dir).split("/").filter(Boolean)) {
    acc += "/" + seg;
    const r = await req("MKCOL", baseUrl + acc + "/", user, pass);
    if (![200, 201, 301, 405].includes(r.status))
      throw new Error("创建目录失败(HTTP " + r.status + ")");
  }
}

/** 上传单个文件（PUT），自动建目录。423(资源被锁,瞬时)退避重试 3 次；大文件给 120s 超时 */
export async function uploadFile(base, user, pass, dir, file, content) {
  await ensureDir(base, user, pass, dir);
  let lastStatus = 0;
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await req("PUT", fileUrl(base, dir, file), user, pass, content, 120000);
    if (r.status >= 200 && r.status < 300) return;
    if (r.status === 423 && attempt < 2) {
      await new Promise((res) => setTimeout(res, 1200 * (attempt + 1))); // 1.2s / 2.4s 退避
      continue;
    }
    lastStatus = r.status;
    break;
  }
  throw new Error(
    `上传 ${file} 失败(HTTP ${lastStatus})` +
      (lastStatus === 423 ? "：文件被服务器锁定(可能被其他程序/同步任务占用),请稍后重试" : "")
  );
}

/** 下载单个文件（GET）；404 返回 null。大文件给 120s 超时 */
export async function downloadFile(base, user, pass, dir, file) {
  const r = await req("GET", fileUrl(base, dir, file), user, pass, null, 120000);
  if (r.status === 404) return null;
  if (r.status >= 200 && r.status < 300) return await r.text();
  throw new Error(`下载 ${file} 失败(HTTP ${r.status})`);
}

/** 测试连接：建目录即可（成功或已存在都算通） */
export async function testConnection(base, user, pass) {
  await ensureDir(base, user, pass);
  return true;
}

/** 导出本地全量镜像并上传全部账本文件（/api/webdav/upload 与 syncNow 共用同一上传循环） */
export async function uploadAll(cfg) {
  exportAccounts(); // 先把 SQLite 账号池导出为镜像文件(trae-accounts.json)
  exportHistory(); // 再把 readings 导出为镜像文件(trae-history.json)
  const uploaded = [];
  for (const f of SYNC_FILES) {
    const p = path.join(TOOLS_DIR, f);
    if (!fs.existsSync(p)) continue;
    await uploadFile(cfg.url, cfg.user, cfg.pass, BACKUP_DIR, f, fs.readFileSync(p));
    uploaded.push(f);
  }
  return uploaded;
}

/** 下载全部账本文件到本地（/api/webdav/download 用；账号/历史导入由调用方决定） */
export async function downloadAll(cfg) {
  const restored = [];
  for (const f of SYNC_FILES) {
    const content = await downloadFile(cfg.url, cfg.user, cfg.pass, BACKUP_DIR, f);
    if (content === null) continue;
    fs.writeFileSync(path.join(TOOLS_DIR, f), content, "utf8");
    restored.push(f);
  }
  return restored;
}

// ---------- 账号槽拉取（v1.4.73：只读拉取 MultiSwitch 同步到 WebDAV 的登录态槽） ----------
// 背景：账户数据(登录态)由 MultiSwitch(登录态切换器)经 sync_engine 双向同步到
//   `workbuddy/workbuddy登录积分/<app_id>/<槽名>.zip(+.meta.json)`（app_id: workbuddy / traework-cn）。
// trae-credits 只读这些槽(SSR: server→断网只拉不传)，解压到本工具 TOOLS_DIR/backups/<app_id>/<槽>，
// 供 discoverDataRoots()/discoverWbInfoFiles() 发现并解析账号，实现换机后「云同步即得账号」。
// 积分镜像(trae积分/)现有同步逻辑完全不变，也不写回远端槽目录。

/** PROPFIND 列目录(decode url 段)；返回名称数组(仅 404/无权限抛错,其余容忍) */
async function listDir(base, user, pass, dir) {
  const r = await req("PROPFIND", `${baseOf(base)}/${dir}/`, user, pass, null, 20000, {
    Depth: "1",
  });
  if (r.status === 404) return [];
  if (r.status >= 200 && r.status < 300) {
    const xml = await r.text();
    const hrefs = [];
    const re = /<([A-Za-z0-9_-]+:)?href\b>([^<]*)<\/([A-Za-z0-9_-]+:)?href>/g;
    let m;
    while ((m = re.exec(xml))) hrefs.push(decodeURIComponent(m[2]));
    return hrefs
      .map((h) => h.split("/").filter(Boolean).pop() || "")
      .filter((n) => n && !n.endsWith("/"));
  }
  throw new Error(`列目录 ${dir} 失败(HTTP ${r.status})`);
}

/** 二进制下载一个远端文件；404 返回 null */
async function downloadBinary(base, user, pass, remotePath) {
  const r = await req("GET", `${baseOf(base)}/${remotePath}`, user, pass, null, 120000);
  if (r.status === 404) return null;
  if (r.status >= 200 && r.status < 300) return Buffer.from(await r.arrayBuffer());
  throw new Error(`下载 ${remotePath} 失败(HTTP ${r.status})`);
}

/** 清空本地槽目录后重建(拉取为权威重置:远端槽覆盖本地同名槽) */
function resetSlotDir(appId, slot) {
  const dir = path.join(trailSlotRoot(appId === "workbuddy"), slot);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// ---------- 账号槽拉取（v1.5.x：直拉积分程序标准树） ----------
// 由「登录态切换器」MultiSwitch 在同步时把每个槽的登录态凭证，按本工具标准目录树另传一份到
// `trae-credits/登录态`（见 MultiSwitch sync_engine.py 的 CREDITS_DIR）。
// 本工具只读拉取该标准树即可用（SSR: server→断网只拉不传），标准布局：
//   workbuddy: <root>/workbuddy/<槽>/workbuddy-desktop.info
//   trae     : <root>/trae/<槽>/User/globalStorage/storage.json
// 拉下来直接落盘到本工具指定登录态根(env WB_SLOT_ROOT/TRAE_SLOT_ROOT 或 TOOLS_DIR/backups/<app>)，
// 供 discoverDataRoots()/discoverWbInfoFiles() 识别，实现换机后「云同步即得账号」。

/** 积分程序标准树远端根（与切先器 sync_engine.py 的 CREDITS_DIR 严格一致） */
export const CREDITS_ROOT = "trae-credits/登录态";

/** 各来源的标准凭证文件（远端相对 <root>/<app>/<槽>/ 段 → 本地落盘文件） */
const CREDITS_FILES = {
  workbuddy: { rel: "workbuddy-desktop.info", wb: true },
  trae: { rel: path.join("User", "globalStorage", "storage.json"), wb: false },
};

/**
 * 只读拉取积分程序标准树里的账号槽(上线传一句都不用)。
 * @returns {Array<{app,slot,pulled:boolean}>} 拉取清单(含版本/失败 Item)
 */
export async function pullRemoteSlots(cfg) {
  const results = [];
  for (const [app, spec] of Object.entries(CREDITS_FILES)) {
    let slots;
    try {
      slots = await listDir(cfg.url, cfg.user, cfg.pass, `${CREDITS_ROOT}/${app}`);
    } catch (e) {
      results.push({ app, slots: 0, note: `列目录失败:${e.message}` });
      continue;
    }
    if (!slots.length) continue;
    for (const slot of slots) {
      if (slot.toLowerCase().endsWith(".meta.json")) continue;
      const remote = `${CREDITS_ROOT}/${app}/${slot}/${spec.rel}`;
      try {
        const bin = await downloadBinary(cfg.url, cfg.user, cfg.pass, remote);
        if (bin === null) continue; // 该槽缺凭证(未登录),跳过
        const out = resetSlotDir(app, slot);
        const localFile = path.join(out, spec.rel);
        fs.mkdirSync(path.dirname(localFile), { recursive: true });
        fs.writeFileSync(localFile, bin);
        results.push({ app, slot, pulled: true });
      } catch (e) {
        results.push({ app, slot, error: e.message });
      }
    }
  }
  return results;
}

// 幂等自动拉槽（v1.4.75：部署机免手动同步）。仅当 wb-sync.json 已配 url 且本地 backups 完全无槽时
// 才触发一次 pullRemoteSlots；进程内只尝试一次（成功或失败都标记，避免周期刷新反复请求/重建目录）。
let _autoPulled = false;
export async function autoPullSlotsIfMissing() {
  if (_autoPulled) return { pulled: 0, reason: "already-tried" };
  const cfg = loadSyncConfig();
  if (!cfg || !cfg.url || !cfg.user) {
    _autoPulled = true;
    return { pulled: 0, reason: "no-webdav-config" };
  }
  // 任一 app 已落槽即认为就绪（避免每次刷新对已存在槽重建覆盖）
  const hasAnySlot = ["trae", "workbuddy"].some((app) => {
    try {
      const d = trailSlotRoot(app === "workbuddy");
      return fs.existsSync(d) && fs.readdirSync(d).length > 0;
    } catch {
      return false;
    }
  });
  if (hasAnySlot) {
    _autoPulled = true;
    return { pulled: 0, reason: "slots-present" };
  }
  try {
    const slots = await pullRemoteSlots(cfg);
    _autoPulled = true;
    return { pulled: slots.filter((s) => s.pulled && !s.error).length, slots };
  } catch (e) {
    _autoPulled = true;
    return { pulled: 0, reason: "error", error: e.message };
  }
}

// ---------- 一键同步（v1.4.46 方案，v1.4.58 从 wb-gui.mjs 路由内嵌搬回，薄路由） ----------
// ① 拉：下载远端 trae-accounts.json + trae-history.json(404=首次,跳过拉取;网络失败=中止,不上传)
// ② 合：账号走 smart 合并(双向取最新 + 墓碑删除传播)，历史走合并导入(append-only 无墓碑)
// ③ 传：导出本地全量(账号+墓碑+历史)覆盖上传，远端固定保留最新 1 份
// 清空保护(v1.4.48)：远端有账号但合并后本地为空 → 拒绝上传(防墓碑误删清空云端)。
// 墓碑 TTL 清理必须在「上传成功之后」执行(v1.4.51 P0)：墓碑先随本次上传写入远端权威备份
// 再清理本地，否则①合并时墓碑被删→远端旧账号被当无墓碑导入(当次复活)②导出不含墓碑→
// 远端备份被覆盖丢失删除标记→其他设备删除"复活"(对齐 edge-multi-account-cookie v2.11.3)。
/**
 * 一键同步（先拉后传）。
 * @param {{url:string,user:string,pass:string}} cfg 同步配置（由调用方提供，如 GUI 的 syncCfg()）
 * @returns {{ok:true, first:boolean, pulled:object|null, pushed:string[], message:string}}
 */
export async function syncNow(cfg) {
  // ---- 拉取阶段:全部下载到内存,任一失败即中止(防止部分合并 + 旧数据覆盖远端) ----
  let accJson = null, histJson = null;
  try {
    accJson = await downloadFile(cfg.url, cfg.user, cfg.pass, BACKUP_DIR, ACC_FNAME);
    histJson = await downloadFile(cfg.url, cfg.user, cfg.pass, BACKUP_DIR, HIST_FNAME);
  } catch (e) {
    throw new Error("同步中止: 拉取远端失败,未上传本地数据(" + e.message + ")");
  }
  // ---- 账号槽拉取(v1.4.73):只读拉取 MultiSwitch 同步的登录态槽到本地,供账号发现 ----
  // 附加能力:即使失败也不影响积分镜像同步(单独 try 吞掉),仅计入 message 提示。
  let slots = [];
  try {
    slots = await pullRemoteSlots(cfg);
  } catch {}
  const pulledSlots = slots.filter((s) => s.pulled && !s.error);
  const slotNote = pulledSlots.length
    ? `,拉取账号槽 ${pulledSlots.map((s) => `${s.app}/${s.slot}`).join("、")}`
    : "";
  // ---- 合并阶段 ----
  const pullStats = { added: 0, updated: 0, skipped: 0, tombstoned: 0, resurrected: 0 };
  let remoteHadAccounts = false; // 远端原本是否有账号(清空保护用)
  if (accJson !== null) {
    let j = null;
    try { j = JSON.parse(accJson); } catch {}
    const accountsIn = j && Array.isArray(j.accounts) ? j.accounts : [];
    remoteHadAccounts = accountsIn.length > 0;
    // 远端墓碑并入本地墓碑(取 deletedAt 更新者)——删除标记随备份传播的关键
    if (j && Array.isArray(j.tombstones)) {
      const localTombs = loadTombstones();
      const newer = [];
      for (const t of j.tombstones) {
        if (!t || !t.uin) continue;
        const key = String(t.uin);
        if (!localTombs.has(key) || (t.deletedAt || "") > localTombs.get(key)) newer.push(key);
      }
      if (newer.length) tombstoneUins(newer);
    }
    const accounts = loadAccounts();
    const st = mergeAccountsSmart(accounts, accountsIn, loadTombstones());
    saveAccounts(accounts);
    Object.assign(pullStats, st);
    // v1.4.48 清空保护:远端有账号但合并后本地为空(墓碑误删/异常) → 拒绝上传,防云端被清空
    if (remoteHadAccounts && loadAccounts().length === 0) {
      throw new Error(
        "同步中止: 合并后账号池为空但远端有 " + accountsIn.length + " 个账号,拒绝上传覆盖。" +
        "可能是墓碑误删(用「清空本地数据」后),请在服务端清理 tombstones 表后重试"
      );
    }
  }
  if (histJson !== null) {
    fs.writeFileSync(HISTORY_FILE, histJson, "utf8");
    importHistory(); // 合并导入(原始 ts + 同分钟去重 + 摘要恢复),不破坏本地
  }
  // ---- 拉到的登录态槽自动注册为账号(发现即入库,与 GUI 读取同一逻辑):新增槽即入池,随本次上传备份 ----
  await reconcileFromDisk();
  // ---- 凭证路径重写(v1.4.73):拉取槽后,把失效的桌面绝对路径改为 TOOLS_DIR/backups 下存在的槽文件 ----
  // 平台版/新机:账号池 cookieHeader 指向本机旧路径(Desktop\...)。拉取槽 + 合并后若仍指向不存在路径,
  // 按槽名重写到本地新拉取的槽,使查询不再 ENOENT。重写结果随 uploadAll 上传,保证跨端一致。
  const accounts = loadAccounts();
  const rewritten = rewriteAccountPaths(accounts);
  if (rewritten > 0) saveAccounts(accounts);
  // ---- 上传阶段:导出本地全量覆盖远端（复用 uploadAll 统一循环） ----
  const uploaded = await uploadAll(cfg);
  purgeOldTombstones(); // 上传成功后清理本地过期墓碑(远端备份已保留删除标记)
  const isFirst = accJson === null && histJson === null;
  const detail = isFirst
    ? "首次同步"
    : `拉取合并(新增 ${pullStats.added} · 更新 ${pullStats.updated} · 删除 ${pullStats.tombstoned} · 复活 ${pullStats.resurrected})`;
  const pathNote = rewritten ? `,重写凭证路径 ${rewritten} 条` : "";
  return {
    ok: true,
    first: isFirst,
    pulled: isFirst ? null : pullStats,
    pushed: uploaded,
    pulledSlots,
    rewritten,
    message: `✅ 同步完成:${detail},已上传 ${uploaded.length} 个文件${slotNote}${pathNote}`,
  };
}
