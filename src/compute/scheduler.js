// src/compute/scheduler.js - 采样调度器（P1 核心）
//
// 职责：后台常驻，按自适应间隔周期性调用 sampleAll（统一采样入口：采集→快照落盘），
// 并在产生新快照后通过注入的 notifier 广播（驱动 SSE 实时推送）。
//
// 自适应间隔策略（参考 CodexPool「剩余越少采得越密」思想，针对本场景调参）：
//   - 任一账号凭证将在 2 天内过期  → 5min（临近失效，需尽快发现以便人工续期）
//   - 任一账号总剩余 < 1000         → 10min（消耗偏快，加密观察）
//   - 其他                          → 15min（健康，低频即可）
// 用量查询走「零成本接口」，后台采样不消耗额度。
import { loadAccounts } from "./store.js";
import { loadHistory } from "./history.js";
import { sampleAll } from "./sample.js";

const DEFAULT_MIN = 15;
const CRITICAL_REMAIN = 1000; // 剩余低于此视为偏紧
const EXPIRE_SOON_DAYS = 2; // 凭证 X 天内过期视为紧急

const S = {
  enabled: false,
  mode: "idle", // idle | auto | manual
  intervalMin: DEFAULT_MIN,
  lastRunAt: null,
  nextRunAt: null,
  lastCount: 0,
  lastError: null,
  _timer: null,
};

let notifier = null;

/** 注入一个回调：每次成功采样后调用，用于驱动 SSE 广播 */
export function setNotifier(fn) {
  notifier = typeof fn === "function" ? fn : null;
}

/** 根据当前账号剩余与凭证到期情况计算下一次采样间隔（分钟） */
function computeIntervalMin() {
  const accounts = loadAccounts();
  if (!accounts.length) return DEFAULT_MIN;
  const hist = loadHistory();
  const lastSnap = hist.length ? hist[hist.length - 1].entries : [];
  const byUin = new Map(lastSnap.map((e) => [e.uin, e]));
  const now = Date.now();
  let minRemain = Infinity;
  let expiringSoon = false;
  for (const a of accounts) {
    const e = byUin.get(a.uin);
    const rem = e ? (e.giftRemain || 0) + (e.baseRemain || 0) : Infinity;
    if (rem < minRemain) minRemain = rem;
    if (a.sessionExpiresAt) {
      const days = (new Date(a.sessionExpiresAt).getTime() - now) / 86400000;
      if (days < EXPIRE_SOON_DAYS) expiringSoon = true;
    }
  }
  if (expiringSoon) return 5;
  if (minRemain < CRITICAL_REMAIN) return 10;
  return DEFAULT_MIN;
}

/** 执行一次采样：统一入口 sampleAll 完成「采集→快照落盘」，此处只维护调度状态与 SSE 广播 */
export async function runOnce() {
  const accounts = loadAccounts();
  S.lastRunAt = Date.now();
  if (!accounts.length) {
    S.lastCount = 0;
    S.lastError = "no-accounts";
    return { count: 0 };
  }
  const { entries } = await sampleAll({
    onSampled: (ents) => {
      S.lastCount = ents.length;
      if (notifier) {
        notifier({
          type: "refresh",
          ts: new Date().toISOString(),
          count: ents.length,
          mode: S.mode,
        });
      }
    },
  });
  S.lastCount = entries.length;
  S.lastError = entries.length ? null : "no-data";
  return { count: entries.length };
}

function scheduleNext() {
  if (!S.enabled) return;
  const iv = computeIntervalMin();
  S.intervalMin = iv;
  S.nextRunAt = Date.now() + iv * 60000;
  S._timer = setTimeout(async () => {
    if (!S.enabled) return;
    S.mode = "auto";
    try {
      await runOnce();
    } catch (e) {
      S.lastError = e.message || String(e);
    }
    scheduleNext();
  }, iv * 60000);
}

/** 启动采样调度（默认开启，进程常驻即可持续产生快照） */
export function start({ intervalMin } = {}) {
  if (intervalMin && intervalMin > 0) S.intervalMin = intervalMin;
  S.enabled = true;
  scheduleNext();
}

/** 停止采样调度 */
export function stop() {
  S.enabled = false;
  if (S._timer) clearTimeout(S._timer);
  S._timer = null;
  S.nextRunAt = null;
  S.mode = "idle";
}

/** 手动立即采样一次（不改调度节奏） */
export async function runNow() {
  S.mode = "manual";
  return runOnce();
}

/** 对外状态（供 /api/scheduler/status 返回，便于前端展示「下次采样」） */
export function getStatus() {
  return {
    enabled: S.enabled,
    running: !!S._timer,
    mode: S.mode,
    intervalMin: S.intervalMin,
    nextRunAt: S.nextRunAt ? new Date(S.nextRunAt).toISOString() : null,
    lastRunAt: S.lastRunAt ? new Date(S.lastRunAt).toISOString() : null,
    lastCount: S.lastCount,
    lastError: S.lastError,
  };
}
