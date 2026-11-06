// src/compute/trae-decrypt.js - TRAE 账号认证解析（路径型/内联型统一入口）
// 解密本体已下沉到 trae-storage.js（v1.12.6，断 trae-decrypt <-> paths 循环依赖），
// 这里 re-export 保持既有 import 路径不变（discover.js 等继续从本模块取）。
import fs from "node:fs";
import path from "node:path";
import { discoverDataRoots } from "../config.js";
import { resolveSlotPath } from "./paths.js";
import { readAuthFromStorage } from "./trae-storage.js";

export { readAuthFromStorage };

/**
 * 从账号记录的 cookieHeader 解析实时认证（token + deviceId + userId）。
 * cookieHeader 支持两种语义（按内容自动判别）：
 *   1) 旧式：指向某个 storage.json 的绝对路径 → 现场解密（本机登录态 / MultiSwitch 槽）。
 *   2) 内联凭证（v1.5.x 支持 MultiSwitch「🔑导出凭证」json 导入）：一段 JSON 字符串，含
 *      {token, userId, account:{username}, expiredAt, host, deviceId?} 等导出字段。
 *      此类账号不依赖本机 storage.json，token 由导出内容直接提供（deviceId 可缺省，接口不强制）。
 * @returns {{auth:object, deviceId:string|null, storagePath:string|null, inline:boolean}}
 * @throws 两者都无法解析时抛错
 */
export function readAccountAuth(account) {
  const ch = (account && account.cookieHeader) || "";
  if (!ch) throw new Error("账号未绑定凭证(cookieHeader 为空)");
  // 情况 1：cookieHeader 是已存在的文件路径 → storage.json 现场解密
  if (fs.existsSync(ch)) {
    const r = readAuthFromStorage(ch);
    return { ...r, inline: false };
  }
  // 情况 1b(平台版/换机自愈)：失效路径 → 按账号槽名确定性拼「本工具指定根」下的槽文件
  // （直读指定目录，不做目录扫描/同名猜测；文件缺失给明确提示而非误报「非法 JSON」）
  // 注意:即使 resolved===ch(已被 rewriteAccountPaths 重写过但文件仍缺失),也要走本分支报明确错,
  // 不能掉到「既非路径也非内联」兜底,否则用户看不到真实原因。
  const resolved = resolveSlotPath(account);
  const isPath = resolved && resolved[0] !== "{" && resolved[0] !== "[";
  if (isPath) {
    const norm = path.normalize(resolved);
    if (fs.existsSync(norm)) {
      return { ...readAuthFromStorage(norm), inline: false };
    }
    throw new Error(
      `本机未找到该账号登录态槽: ${norm}\n` +
        `请先「云同步」把登录态拉到本工具指定目录（可用环境变量 WB_SLOT_ROOT / TRAE_SLOT_ROOT 指向部署机专有目录）`
    );
  }
  // 情况 2：尝试解析为内联凭证 JSON（MultiSwitch export json 经 accountFromMultiSwitchExport 封装）
  const s = String(ch).trim();
  if (s.startsWith("{") || s.startsWith("[") || (s.includes('"token"') && s.includes('"'))) {
    let inline;
    try {
      inline = JSON.parse(s);
    } catch {
      throw new Error("凭证既非有效文件路径，也非合法 JSON（登录态可能已失效）");
    }
    if (inline && inline.token) {
      const acct = inline.account && typeof inline.account === "object" ? inline.account : {};
      return {
        auth: {
          token: inline.token,
          userId: inline.userId || acct.userId || "",
          account: acct,
          expiredAt: inline.expiredAt,
        },
        deviceId: inline.deviceId || null,
        machineId: inline.machineId || null,
        storagePath: null,
        inline: true,
      };
    }
    throw new Error("内联凭证缺 token，无法查询");
  }
  throw new Error("凭证既非文件路径也非内联 token，无法查询");
}

/** 便捷：从第一个可用 storage.json 读当前账号（登录态优先，其次首个槽） */
export function loadCurrentAuth() {
  const roots = discoverDataRoots();
  if (!roots.length) throw new Error("未找到任何 TRAE 登录态，请先登录 TRAE 或配置槽目录");
  // 优先无槽（本机登录态）
  const local = roots.find((r) => !r.slotName) || roots[0];
  return readAuthFromStorage(local.storage);
}
