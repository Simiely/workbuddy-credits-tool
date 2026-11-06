// src/compute/device-pool.js - TRAE 签到设备号去重池（v1.12.12）
//
// 背景：TRAE checkin_credits/claim 按 x-device-id 做「每设备每日一次」校验。
// 多个账号从同一台机器导出登录态时，storage.json 里的 iCubeAuthInfo://icube-dc:<id>
// 会重复；当天第二个账号领取返回 code 9095「当前设备今日已经签到，请明日再来哦～」。
// 解决：扫描本机所有 TRAE 槽，收集全部「已登记」设备号，按账号稳定分配互不冲突的一个。
// 只使用登录态里真实存在的 id —— 伪造 id 返回 9074、空 id 返回 9004（v1.9.3 A/B 实测）。
//
// 本模块只被 query.js 的签到路径引用，不落盘任何凭证，也不修改登录态文件。
import fs from "node:fs";
import path from "node:path";
import { trailSlotRoot } from "../config.js";
import { dayKeyOf } from "../time.js";

const DC_PREFIX = "iCubeAuthInfo://icube-dc:";
let _cache = null;

function collect() {
  const ids = [];
  const root = trailSlotRoot(false);
  try {
    for (const ent of fs.readdirSync(root, { withFileTypes: true })) {
      if (!ent.isDirectory()) continue;
      const p = path.join(root, ent.name, "User", "globalStorage", "storage.json");
      let raw;
      try {
        raw = JSON.parse(fs.readFileSync(p, "utf8"));
      } catch {
        continue;
      }
      for (const k of Object.keys(raw)) {
        if (!k.startsWith(DC_PREFIX)) continue;
        const id = k.slice(DC_PREFIX.length);
        if (id && !ids.includes(id)) ids.push(id);
      }
    }
  } catch {
    /* 槽目录不存在时返回空池，调用方按原设备号执行并如实报错 */
  }
  return ids;
}

/** 本机全部已登记设备号（进程内缓存；槽更新后可 clearDevicePoolCache） */
export function registeredDeviceIds() {
  if (!_cache) _cache = collect();
  return _cache.slice();
}

export function clearDevicePoolCache() {
  _cache = null;
}

// 每个中国自然日、每个账号固定分配一个设备号；同一天重复调用返回同一个值。
const _assigned = new Map(); // day -> Map<uin, deviceId>

/**
 * 给账号挑一个不与当天其它账号冲突的设备号。
 * 首选账号自己的 icube-dc；已被占用时从真实设备号池里挑一个未使用的。
 */
export function pickDeviceId(uin, primary) {
  const day = dayKeyOf(Date.now());
  let m = _assigned.get(day);
  if (!m) {
    m = new Map();
    _assigned.set(day, m);
    if (_assigned.size > 3) _assigned.delete(_assigned.keys().next().value);
  }
  const key = String(uin || "?");
  if (m.has(key)) return m.get(key);
  const used = new Set(m.values());
  let chosen = primary || "";
  if (!chosen || used.has(chosen)) {
    chosen = registeredDeviceIds().find((id) => !used.has(id)) || chosen;
  }
  m.set(key, chosen);
  return chosen;
}
