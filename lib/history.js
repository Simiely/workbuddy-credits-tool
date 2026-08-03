// lib/history.js - 本地缓存与历史快照
// 数据模型:积分包本身静态(总量/到期不变),变化的是"消耗"。
//   - wb-last-data.json :最近一次完整查询结果(含每个账号完整 data,离线可看/明细可用)
//   - wb-history.json   :历史快照(每次成功刷新记录一次摘要,按账号记剩余/已用)
import fs from "node:fs";
import path from "node:path";
import { TOOLS_DIR, HISTORY_LIMIT } from "./util.js";

const LAST_FILE = path.join(TOOLS_DIR, "wb-last-data.json");
const HIST_FILE = path.join(TOOLS_DIR, "wb-history.json");
const DEDUP_MINUTES = 1;        // 同账号同分钟去重,避免频繁刷新刷爆历史

// 异步写盘队列:高频刷新时合并写,不阻塞事件循环
let writeQueue = Promise.resolve();
function enqueueWrite(fn) {
  writeQueue = writeQueue.then(fn).catch(() => {});
}

// ---------- 最近一次结果缓存 ----------
export function loadLastData() {
  if (!fs.existsSync(LAST_FILE)) return null;
  try {
    const j = JSON.parse(fs.readFileSync(LAST_FILE, "utf8"));
    return j && j.fetchedAt ? j : null;
  } catch {
    return null;
  }
}

/** 保存最近一次完整查询结果(与 /api/all 返回同构) */
export function saveLastData(allResult) {
  enqueueWrite(() => fs.promises.writeFile(LAST_FILE, JSON.stringify(allResult, null, 1), "utf8"));
}

// ---------- 历史快照 ----------
export function loadHistory() {
  if (!fs.existsSync(HIST_FILE)) return [];
  try {
    const j = JSON.parse(fs.readFileSync(HIST_FILE, "utf8"));
    return Array.isArray(j.snapshots) ? j.snapshots : [];
  } catch {
    return [];
  }
}

function saveHistory(snapshots) {
  enqueueWrite(() => fs.promises.writeFile(HIST_FILE, JSON.stringify({ updatedAt: new Date().toISOString(), snapshots }, null, 1), "utf8"));
}

/**
 * 追加一条历史快照(同分钟去重,超上限裁掉最旧)。
 * @param {Array<{uin,name,displayName,baseRemain,giftUsed,giftRemain}>} entries 各账号摘要
 */
export function appendSnapshot(entries) {
  const snapshots = loadHistory();
  const ts = new Date();
  const tsMin = ts.toISOString().slice(0, 16); // 分钟级去重键
  const last = snapshots[snapshots.length - 1];
  if (last && last.ts.startsWith(tsMin)) return; // 同一分钟内已有快照,跳过
  snapshots.push({ ts: ts.toISOString(), entries });
  if (snapshots.length > HISTORY_LIMIT) snapshots.splice(0, snapshots.length - HISTORY_LIMIT);
  saveHistory(snapshots);
}

/**
 * 查询某账号的历史(按时间升序)。
 * @param {string} uin
 * @returns {Array<{ts, baseRemain, giftUsed, giftRemain}>}
 */
export function historyFor(uin) {
  return loadHistory()
    .map((s) => {
      const e = (s.entries || []).find((x) => x.uin === uin);
      if (!e) return null;
      const baseRemain = e.baseRemain ?? 0;
      const baseUsed = e.baseUsed ?? 0; // 老快照无此字段时按 0
      return {
        ts: s.ts,
        baseRemain, baseUsed,
        giftUsed: e.giftUsed, giftRemain: e.giftRemain,
        totalRemain: (e.giftRemain ?? 0) + baseRemain, // 总剩余 = 体验版 + 赠送
        totalUsed: (e.giftUsed ?? 0) + baseUsed,       // 累计已用 = 体验版 + 赠送
      };
    })
    .filter(Boolean)
    .sort((a, b) => (a.ts < b.ts ? -1 : 1)); // 按时间升序
}
