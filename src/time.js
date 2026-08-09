// src/time.js - 中国时区(UTC+8)时间工具（v1.4.58 收敛：全后端统一口径，替代各文件重复实现）
//
// 背景：容器(node:alpine 默认 UTC)与桌面(Windows GMT+8)进程时区不同，若按"进程本地时区"算
// 自然日/显示时间，会错位一天（8/3→8/2）、界面时间显示错。统一按 +8 计算，与部署环境无关。
// 所有"自然日计算 / 时间显示"一律从本模块取口径（derive / history / scheduler / gc / present / gui）。
const TZ_MS = 8 * 3600 * 1000;

const pad = (n) => String(n).padStart(2, "0");

/** 真实 UTC 时刻 → 中国墙上时间（UTC 视图，供取 Y/M/D 字段） */
export function cnWall(utcMs) {
  return new Date(utcMs + TZ_MS);
}

/** 中国当天 00:00 的真实 UTC 时刻 */
export function cnDay0(utcMs) {
  const w = cnWall(utcMs);
  return new Date(Date.UTC(w.getUTCFullYear(), w.getUTCMonth(), w.getUTCDate()) - TZ_MS);
}

/** 自然日键 YYYY-MM-DD（统一按中国时区 +8） */
export function dayKeyOf(ts) {
  const w = cnWall(new Date(ts).getTime());
  return `${w.getUTCFullYear()}-${pad(w.getUTCMonth() + 1)}-${pad(w.getUTCDate())}`;
}

/** 自然日偏移:day('YYYY-MM-DD') 加/减 offsetDays,仍按中国时区自然日 */
export function dayOfOffset(day, offsetDays) {
  const [y, m, d] = day.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d) + offsetDays * 86400000);
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
}

/** 中国时区今天 00:00（真实 UTC 时刻） */
export function startOfToday() {
  return cnDay0(Date.now());
}

/** 固定中国时区(+8)格式化当前时间：YYYY/MM/DD HH:mm:ss（CLI/GUI 显示统一口径） */
export function cnNow() {
  const d = cnWall(Date.now());
  return `${d.getUTCFullYear()}/${pad(d.getUTCMonth() + 1)}/${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

export { TZ_MS };
