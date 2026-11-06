// src/compute/checkin.js - 每日自动签到（v1.7.0）
//
// 把 CLI `trae-credits.mjs checkin` 的双源逻辑（TRAE=storage.json 现解密 token；
// WorkBuddy=.info Bearer）服务端化，供调度器每日定时调用 + /api/checkin/run 手动触发。
//
// 设计要点：
//   - 签到只用 JWT + deviceId（X-Device-Id），**不碰 RefreshToken** —— 与切器保鲜
//     （RT 单写者）天然无冲突；
//   - 幂等：status 已签则跳过，重复运行/进程重启都安全；
//   - 凭证保鲜前置：先 pullRemoteSlots（拉云端 `trae-credits/登录态` 标准树，SSR 只读）
//     → reconcileFromDisk（对账入库）—— 用户在专用设备重登推槽后，签到自动用上新凭证；
//   - 时区口径统一走 time.js 的中国墙钟（dayKeyOf），容器 UTC 也不会错天。
import fs from "node:fs";
import path from "node:path";
import { TOOLS_DIR } from "../config.js";
import { cnWall, dayKeyOf } from "../time.js";
import { loadAccounts, reconcileFromDisk } from "./store.js";
import { isWorkBuddy, readWbInfo, fetchWbCheckinStatus, fetchWbDailyCheckin } from "./wb.js";
import { fetchTraeCheckin, fetchTraeCheckinStatus } from "./query.js";
import { pullRemoteSlots, loadSyncConfig } from "./webdav.js";

const STATE_FILE = path.join(TOOLS_DIR, "checkin-state.json");
const HISTORY_FILE = path.join(TOOLS_DIR, "checkin-history.json");
const HISTORY_MAX = 120; // 留最近 120 天明细
// v1.9.3：重试节奏重构。原 6 次/天（tick 每 5 分钟 → 只覆盖 30 分钟窗口），
// 且 9074 高峰限流往往持续 1 小时以上 —— 6 次根本熬不过去。改为跨小时分散：
// 每次尝试至少间隔 RETRY_GAP_MIN 分钟、当天最多 MAX_RETRY_PER_DAY 次。
// ⚠️ 这两个值都要在 shouldRunCheckinNow 的门闸里生效（不只是 runDailyCheckin 里计数）。
const MAX_RETRY_PER_DAY = 12;      // 当天最多尝试次数（含首次）
const RETRY_GAP_MIN = 30;          // 两次尝试的最小间隔（分钟），跨小时分散重试
export { MAX_RETRY_PER_DAY, RETRY_GAP_MIN };


function _readJson(p, dft) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return dft;
  }
}

function _writeJson(p, v) {
  try {
    fs.writeFileSync(p, JSON.stringify(v, null, 1), "utf8");
  } catch {
    /* 状态文件写失败不影响签到本身 */
  }
}

/** 签到触发时刻（中国墙钟小时，env TRAE_CHECKIN_HOUR 可覆盖，默认 8 点后首个调度 tick 执行） */
export function checkinHour() {
  const v = parseInt(process.env.TRAE_CHECKIN_HOUR ?? "8", 10);
  return Number.isFinite(v) ? Math.min(Math.max(v, 0), 23) : 8;
}

/**
 * 纯函数判据（便于单测）：此刻是否应执行当日签到。
 * v1.9.3 门闸（顺序敏感）：
 *   ① 当天已成功（lastDate === today）→ 不跑；
 *   ② 未到中国墙钟阈值（默认 8 点）→ 不跑；
 *   ③ 今天已尝试 MAX_RETRY_PER_DAY 次 → 不跑（次数用尽，次日再试）；
 *   ④ 距上次尝试不足 RETRY_GAP_MIN 分钟 → 不跑（9074 高峰限流要跨小时等，别 5 分钟硬撞）。
 * 🔴 v1.9.3 修复：旧实现在 `runDailyCheckin` 里 `state.attemptsDay = result.day;` 写在
 *    三元比较**之前**，条件恒真 → `attempts` 变成终身计数、从不按天归零；`attempts >= 6`
 *    从第 6 次起永远成立，导致"失败自动重试"从 2026-10-03 起永久失效（详见 CHANGELOG v1.9.3）。
 * @param {number} utcMs 真实 UTC 时刻
 * @param {{lastDate?: string|null, attemptsDay?: string|null, attempts?: number, lastRunAt?: string|null}} state 持久化状态
 */
export function shouldRunCheckinNow(utcMs, state) {
  const s = state || {};
  const today = dayKeyOf(utcMs);
  if (s.lastDate === today) return false;                        // ① 今天已成功
  if (cnWall(utcMs).getUTCHours() < checkinHour()) return false; // ② 未到阈值
  if (s.attemptsDay === today && (s.attempts || 0) >= MAX_RETRY_PER_DAY) return false; // ③ 次数用尽
  const last = s.lastRunAt ? Date.parse(s.lastRunAt) : 0;        // ④ 最小间隔
  if (Number.isFinite(last) && last > 0 && utcMs - last < RETRY_GAP_MIN * 60000) return false;
  return true;
}

/**
 * 执行一轮签到（全部账号，双源，幂等）。
 * @param {{dryRun?: boolean, onlyMissing?: boolean, log?: (m:string)=>void}} [opts]
 *   dryRun=true 只查状态不领取（safe）；onlyMissing=true 只给今日未签到的账号补签；
 *   log 进度输出（调度器接 console）。
 * @returns {Promise<{ts, day, dryRun, pulledCount: number|null, added, already, failed,
 *                     rows: Array<{name, source, result, credit?, streak?, msg?}>}>}
 */
export async function runDailyCheckin({ dryRun = false, onlyMissing = false, log = () => {} } = {}) {
  const state = _readJson(STATE_FILE, {});

  // 0) 凭证保鲜：拉云端标准树（SSR 只读不回传）→ 对账入库。跟随用户重登/新账号，失败不阻塞（用本地缓存继续）。
  let pulled = null;
  const cfg = loadSyncConfig();
  if (cfg && cfg.url && cfg.user) {
    try {
      pulled = await pullRemoteSlots(cfg);
      const n = Array.isArray(pulled) ? pulled.filter((x) => x.pulled).length : 0;
      log(`凭证拉取: ${n} 项更新`);
    } catch (e) {
      log(`凭证拉取失败(用本地缓存继续): ${e.message}`);
    }
  }
  try {
    await reconcileFromDisk();
  } catch {
    /* 对账失败不阻塞签到（池内还有旧凭证可用） */
  }

  const accounts = loadAccounts();
  const rows = [];
  let added = 0;
  let already = 0;
  let failed = 0;
  let skipped = 0; // v1.12.12 onlyMissing：已签到、完全跳过的账号数

  for (const a of accounts) {
    if (isWorkBuddy(a)) {
      let rec = null;
      try {
        rec = readWbInfo(a.cookieHeader);
      } catch (e) {
        failed++;
        rows.push({ name: a.name || "?", source: "WorkBuddy", result: "failed", msg: e.message });
        continue;
      }
      const name = a.name || rec?.nickname || a.displayName || "?";
      if (dryRun) {
        try {
          const st = await fetchWbCheckinStatus(rec);
          const done = !!(st && (st.today_checked_in || st.checked_in));
          if (done && onlyMissing) { skipped++; continue; }
          if (done) already++;
          else added++;
          rows.push({ name, source: "WorkBuddy", result: done ? "already" : "pending" });
        } catch (e) {
          failed++;
          rows.push({ name, source: "WorkBuddy", result: "failed", msg: e.message });
        }
        continue;
      }
      if (onlyMissing) {
        try {
          const st = await fetchWbCheckinStatus(rec);
          if (st && (st.today_checked_in || st.checked_in)) { skipped++; continue; }
        } catch { /* 状态查询失败不阻断，交给幂等领取判定 */ }
      }
      try {
        const r = await fetchWbDailyCheckin(rec);
        if (r.already) {
          if (onlyMissing) { skipped++; continue; }
          already++;
          rows.push({ name, source: "WorkBuddy", result: "already" });
        } else if (r.ok) {
          added++;
          rows.push({ name, source: "WorkBuddy", result: "added", credit: r.credit, streak: r.streak, msg: r.msg || "" });
        } else {
          failed++;
          rows.push({ name, source: "WorkBuddy", result: "failed", msg: r.msg || "失败" });
        }
      } catch (e) {
        failed++;
        rows.push({ name, source: "WorkBuddy", result: "failed", msg: e.message });
      }
      continue;
    }
    // TRAE 源
    const name = a.displayName || a.name || "?";
    if (dryRun) {
      const r = await fetchTraeCheckinStatus(a);
      if (!r.ok) {
        failed++;
        rows.push({ name, source: "TRAE", result: "failed", msg: r.msg });
      } else {
        if (r.done && onlyMissing) { skipped++; continue; }
        if (r.done) already++;
        else added++;
        rows.push({ name, source: "TRAE", result: r.done ? "already" : "pending" });
      }
      continue;
    }
    // v1.12.12 只补未签：先只读查状态，已签到就直接跳过，不做任何领取请求
    if (onlyMissing) {
      const st = await fetchTraeCheckinStatus(a);
      if (st && st.ok && st.done) { skipped++; continue; }
    }
    const r = await fetchTraeCheckin(a);
    if (r.already) {
      if (onlyMissing) { skipped++; continue; }
      already++;
      rows.push({ name, source: "TRAE", result: "already" });
    } else if (r.ok) {
      added++;
      rows.push({ name, source: "TRAE", result: "added", credit: r.credit, streak: r.streak, msg: r.msg || "" });
    } else {
      failed++;
      rows.push({ name, source: "TRAE", result: "failed", msg: r.msg || "失败" });
    }
  }

  const result = {
    ts: new Date().toISOString(),
    day: dayKeyOf(Date.now()),
    dryRun: !!dryRun,
    onlyMissing: !!onlyMissing,
    skipped,
    pulledCount: Array.isArray(pulled) ? pulled.filter((x) => x.pulled).length : null,
    added,
    already,
    failed,
    rows,
  };
  if (!dryRun) {
    // 失败重试策略：全部成功 → 记 lastDate（今天不再跑）；
    // 有失败 → 不记 lastDate，让后续采样 tick 自动重试（already 账号秒过，代价小），
    // 但同一天最多 MAX_RETRY_PER_DAY 次，防止永久性失败（如绑定吊销）造成无限轮询。
    // 🔴 v1.9.3 修复 attempts 跨天不复位：旧代码把 `state.attemptsDay = result.day` 写在
    //    三元比较之前 → 条件恒真 → attempts 成为**终身计数**，`attempts >= 6` 从第 6 次起
    //    永远成立 → 2026-10-03 起"失败自动重试"永久失效（当天首次失败就写 lastDate 放弃）。
    //    现在显式按天归零，并交给 shouldRunCheckinNow 的 ③④ 门闸控制节奏（跨小时分散）。
    if (state.attemptsDay !== result.day) {
      state.attemptsDay = result.day;
      state.attempts = 1;
    } else {
      state.attempts = (state.attempts || 0) + 1;
    }
    if (failed === 0) {
      state.lastDate = result.day;
    } else if (state.attempts >= MAX_RETRY_PER_DAY) {
      state.lastDate = result.day; // 次数用尽，今日放弃（明天照常再试）
      log(`今日已尝试 ${state.attempts} 次仍有 ${failed} 个失败，今日不再重试`);
    }
    state.lastRunAt = result.ts;
    state.lastResult = { added, already, failed, skipped };
    _writeJson(STATE_FILE, state);
    const hist = _readJson(HISTORY_FILE, []);
    hist.push({ ts: result.ts, day: result.day, onlyMissing: !!onlyMissing, added, already, failed, skipped, rows });
    _writeJson(HISTORY_FILE, hist.slice(-HISTORY_MAX));
  }
  return result;
}

// ---------- v1.9.3：手动触发改异步（绕开 tools-center 60s 反代超时） ----------
// 一次签到最坏 = 6 个 TRAE 串行 × 内层 6 次退避（12s+抖动）≈ 数分钟，远超反代 60s；
// 2026-10-08 实测 HTTP 502 / 60.014s，且被中断的那次在 checkin-history 里**没有记录**
// （不是"报错但后台跑完"）。所以手动触发只负责"启动"，结果走 /api/checkin/status 轮询。
let _inFlight = false;

/** 是否有一轮签到正在跑（供 /api/checkin/status 展示） */
export function checkinInFlight() {
  return _inFlight;
}

/**
 * 后台启动一轮签到（不等待完成）。重复调用直接拒绝，避免并发双跑。
 * @returns {{started:boolean, reason?:string}}
 */
export function startCheckinAsync(log = () => {}, opts = {}) {
  if (_inFlight) return { started: false, reason: "in-flight" };
  _inFlight = true;
  runDailyCheckin({ ...opts, log })
    .catch((e) => log(`后台签到异常: ${e && e.message ? e.message : e}`))
    .finally(() => { _inFlight = false; });
  return { started: true };
}

/** 调度 tick（幂等）：到点且今天没跑过才真正执行；跑失败次日/手动仍可补（幂等）。 */
export async function maybeDailyCheckin(log = (m) => console.log("[checkin]", m)) {
  const state = _readJson(STATE_FILE, {});
  if (!shouldRunCheckinNow(Date.now(), state)) return null;
  log("到达每日签到时刻，开始执行…");
  return runDailyCheckin({ log });
}

/** 对外状态（供 /api/checkin/status） */
export function getCheckinStatus() {
  return {
    hour: checkinHour(),
    state: _readJson(STATE_FILE, {}),
    history: _readJson(HISTORY_FILE, []).slice(-10),
  };
}
