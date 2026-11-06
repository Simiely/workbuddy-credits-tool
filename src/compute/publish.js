// src/compute/publish.js - 采样后自动向 WebDAV 推送「精简积分快照」（v1.6.0）
//
// 为什么需要它（2026-09-22）：
//   MultiSwitch（登录态切换器）的槽卡要显示各账号剩余积分，但它只能「逐槽解密 +
//   直连 api.trae.cn」——12 个账号就是 12 次外网请求，慢且依赖外网可达。
//   本程序本来就每 5 分钟采样一次（数据已在本地 credits.db），于是把「采样结果的
//   精简视图」落成一个小文件推到 WebDAV，切器只读这一个文件即可（1 次内网请求）。
//
// 为什么不直接推 trae-history.json：
//   那是 2.4MB 的全量时序账本，且 WebDAV 上传吞吐实测仅 6~25 KB/s，每次采样都推会
//   拖垮链路。快照只含 uin + 剩余 + 时间戳，几 KB。
//
// 三条设计约束（采样是主流程，发布是附属能力）：
//   1. 不 await：调用方 fire-and-forget，发布再慢也不拖慢/阻塞采样；
//   2. 不抛：所有异常在模块内吞掉（返回结果对象），绝不让采样因发布失败而报错；
//   3. 不刷屏：最小间隔节流 + 内容指纹去重 + 进程内防重入。
//
// 落点：WebDAV 的 BACKUP_DIR（workbuddy/workbuddy登录积分/trae积分）下，
//   与 trae-history.json 同目录，文件名 trae-credits-snapshot.json。
//   切器按 <remote_dir>/trae积分/trae-credits-snapshot.json 读取（见 credits_remote.py）。
import { uploadFile, loadSyncConfig, BACKUP_DIR } from "./webdav.js";

/** 快照文件名（位于 WebDAV 的 BACKUP_DIR 下） */
export const SNAPSHOT_FILE = "trae-credits-snapshot.json";

/** 快照 schema 版本：切器只认自己认识的版本，其余一律当「读不到」（宁可空也不误读字段） */
export const SNAPSHOT_SCHEMA = 1;

/** 最小发布间隔（毫秒）。采样最短 5min 一轮，再加 /api/all 手动刷新，这里兜住频率 */
export const MIN_PUBLISH_INTERVAL_MS = 5 * 60 * 1000;

/** 进程内状态：节流/去重/防重入都靠它（GUI 是常驻进程，跨调用累积） */
const S = { lastAt: 0, lastFp: null, inFlight: false, last: null };

/** 仅供测试：清空进程内状态 */
export function _resetPublishState() {
  S.lastAt = 0;
  S.lastFp = null;
  S.inFlight = false;
  S.last = null;
}

/** 账号所属软件源：appKey(workbuddy|traework) → 快照里的 app 段(trae|workbuddy) */
export function appOf(appKey) {
  return appKey === "workbuddy" ? "workbuddy" : "trae";
}

/** 只接受有限数；null/NaN/字符串一律归一成 null（切器按 null 显示「—」） */
function num(v) {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** 取活跃包中最早的到期时间（cycleEndTime 是 "YYYY-MM-DD HH:mm:ss"，字典序即时间序） */
function earliestExpiry(packs) {
  if (!Array.isArray(packs)) return null;
  let best = null;
  for (const p of packs) {
    const t = p && typeof p.cycleEndTime === "string" ? p.cycleEndTime.trim() : "";
    if (!t) continue;
    if (best === null || t < best) best = t;
  }
  return best;
}

/**
 * 由采样条目构建精简快照（纯函数，便于单测）。
 *
 * @param {Array} entries buildSnapshotEntry 产出的快照条目（含 uin/giftRemain/giftPackages）
 * @param {Array} raw     fetchAllAccounts 原始结果（用来取每条账号的 appKey —— 条目里没带）
 * @param {number} [now]  生成时刻（毫秒），测试可注入
 * @returns {{schema:number, source:string, generatedAt:string, accounts:Array}}
 */
export function buildSnapshot(entries, raw, now = Date.now()) {
  const appByUin = new Map();
  for (const r of raw || []) {
    const a = r && r.account;
    if (a && a.uin != null) appByUin.set(String(a.uin), a.appKey);
  }
  const accounts = [];
  for (const e of entries || []) {
    if (!e || e.uin == null) continue;
    if (num(e.giftRemain) === null) continue; // 无剩余数据 → 不入快照（切器会显示「—」）
    const uin = String(e.uin);
    accounts.push({
      uin,
      app: appOf(appByUin.get(uin)),
      name: e.name || null,
      displayName: e.displayName || e.name || null,
      remain: num(e.giftRemain),
      used: num(e.giftUsed),
      size: num(e.giftSize),
      packs: Array.isArray(e.giftPackages) ? e.giftPackages.length : 0,
      signedIn: e.signedIn ? 1 : 0,
      nextExpiry: earliestExpiry(e.giftPackages),
    });
  }
  // 固定顺序：跨次比较/指纹计算才稳定（Map/DB 顺序不保证）
  accounts.sort((a, b) => (a.app + "\u0000" + a.uin).localeCompare(b.app + "\u0000" + b.uin));
  return {
    schema: SNAPSHOT_SCHEMA,
    source: "trae-credits",
    generatedAt: new Date(now).toISOString(),
    accounts,
  };
}

/**
 * 内容指纹：**不含 generatedAt** —— 只按「账号 + 数值」判是否变了，
 * 否则每次采样时间戳都不同，去重永远失效。
 */
export function fingerprint(snapshot) {
  return (snapshot.accounts || [])
    .map((a) => [a.app, a.uin, a.remain, a.used, a.size, a.packs, a.signedIn].join(":"))
    .join("|");
}

/**
 * 发布一次快照（**不抛异常**，失败只体现在返回值的 reason/error 里）。
 *
 * @param {object} [opts]
 * @param {Array}  [opts.entries] 本次采样条目
 * @param {Array}  [opts.raw]     本次采样原始结果（取 appKey 用）
 * @param {boolean}[opts.force]   跳过节流与去重（测试/手动用）
 * @param {number} [opts.now]     注入当前时刻（测试用）
 * @returns {Promise<{ok:boolean, reason:string, bytes?:number, accounts?:number,
 *                    generatedAt?:string, error?:string}>}
 *   reason 取值：published | no-entries | no-accounts | no-webdav-config |
 *                unchanged | throttled | in-flight | error
 */
export async function publishSnapshot({ entries, raw, force = false, now = Date.now() } = {}) {
  try {
    if (S.inFlight) return { ok: false, reason: "in-flight" };
    if (!entries || !entries.length) return { ok: false, reason: "no-entries" };

    const cfg = loadSyncConfig();
    if (!cfg || !cfg.url || !cfg.user) return { ok: false, reason: "no-webdav-config" };

    const snap = buildSnapshot(entries, raw, now);
    if (!snap.accounts.length) return { ok: false, reason: "no-accounts" };

    const fp = fingerprint(snap);
    if (!force && S.lastFp === fp) return { ok: false, reason: "unchanged" };
    if (!force && S.lastAt && now - S.lastAt < MIN_PUBLISH_INTERVAL_MS) {
      return { ok: false, reason: "throttled" };
    }

    S.inFlight = true;
    try {
      const body = Buffer.from(JSON.stringify(snap), "utf8");
      await uploadFile(cfg.url, cfg.user, cfg.pass, BACKUP_DIR, SNAPSHOT_FILE, body);
      S.lastAt = now;
      S.lastFp = fp;
      S.last = { ok: true, reason: "published", bytes: body.length, accounts: snap.accounts.length, generatedAt: snap.generatedAt };
    } finally {
      S.inFlight = false;
    }
    return S.last;
  } catch (e) {
    // 失败静默：只记账，不向采样主流程抛出
    const msg = e && e.message ? e.message : String(e);
    S.last = { ok: false, reason: "error", error: msg };
    console.error("[publish] 快照推送失败(不影响采样):", msg);
    return S.last;
  }
}

/** 发布状态（排查用：/api/publish/status） */
export function getPublishStatus() {
  return {
    lastAt: S.lastAt ? new Date(S.lastAt).toISOString() : null,
    fingerprint: S.lastFp,
    inFlight: S.inFlight,
    last: S.last,
    minIntervalMs: MIN_PUBLISH_INTERVAL_MS,
    file: SNAPSHOT_FILE,
  };
}
