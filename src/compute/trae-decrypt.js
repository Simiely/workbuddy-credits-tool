// src/compute/trae-decrypt.js - 解密 TRAE 桌面版 storage.json 私有登录态（tc 格式）
// 算法来源：kenuoseclab/trae-local-api (src/trae-decrypt.js) 逆向，AES-128-CBC。
// 仅用于本人本机账号积分/签到查询。token 不落盘明文。
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { discoverDataRoots } from "../config.js";
import { resolveSlotPath } from "./paths.js";

// 4 个硬编码盐（来自 TRAE CN 前端 JS，64 字节）—— 与 Python 版 SALT_A/B/C/D 一致
const SALT_A = Buffer.from([
  82,9,106,213,48,54,165,56,191,64,163,158,129,243,215,251,
  124,227,57,130,155,47,255,135,52,142,67,68,196,222,233,203,
  84,123,148,50,166,194,35,61,238,76,149,11,66,250,195,78,
  8,46,161,102,40,217,36,178,118,91,162,73,109,139,209,37]);
const SALT_B = Buffer.from([
  31,221,168,51,136,7,199,49,177,18,16,89,39,128,236,95,
  96,81,127,169,25,181,74,13,45,229,122,159,147,201,156,239,
  160,224,59,77,174,42,245,176,200,235,187,60,131,83,153,97,
  23,43,4,126,186,119,214,38,225,105,20,99,85,33,12,125]);
const SALT_C = Buffer.from([
  191,192,216,250,122,246,220,97,31,254,98,27,8,72,71,176,
  135,99,96,18,127,101,203,104,211,102,191,125,37,72,150,156,
  51,229,121,35,17,153,141,177,110,131,150,128,172,255,254,6,
  18,140,55,62,236,249,135,64,135,12,117,4,89,149,168,209]);
const SALT_D = Buffer.from([
  246,204,26,232,232,70,129,109,223,146,169,242,23,241,105,145,
  50,196,165,42,254,120,3,54,244,207,209,85,53,6,138,106,
  175,148,31,204,186,186,165,182,87,142,49,10,39,110,26,154,
  86,56,173,125,18,64,198,225,99,99,83,82,191,134,76,170]);

const xor = (a, b) => Buffer.from(a.map((x, i) => x ^ b[i]));

function detectEncType(header) {
  if (header[0] === 0x74 && header[1] === 0x63 && header[2] === 0x05 && header[3] === 0x10 && header[4] === 0x00 && header[5] === 0x00) return "AES";
  if (header[0] === 18 && header[1] === 57 && header[2] === 32 && header[3] === 32 && header[4] === 2 && header[5] === 3) return "AES_PRIVATE";
  return "UNKNOWN";
}

function deriveKeyIv(randomBytes, encType) {
  const salt = encType === "AES_PRIVATE" ? xor(SALT_C, SALT_D) : xor(SALT_A, SALT_B);
  const hashOfRandom = crypto.createHash("sha512").update(randomBytes).digest();
  const finalHash = crypto.createHash("sha512").update(Buffer.concat([hashOfRandom, salt])).digest();
  return { key: finalHash.subarray(0, 16), iv: finalHash.subarray(16, 32) };
}

function decryptStorageValue(b64val) {
  const buf = Buffer.from(b64val, "base64");
  const header = buf.subarray(0, 6);
  const randomBytes = buf.subarray(6, 38);
  const encData = buf.subarray(38);
  const encType = detectEncType(header);
  if (encType === "UNKNOWN") throw new Error("Unknown encryption type: " + header.toString("hex"));
  const { key, iv } = deriveKeyIv(randomBytes, encType);
  const decipher = crypto.createDecipheriv("aes-128-cbc", key, iv);
  decipher.setAutoPadding(false);
  let dec = Buffer.concat([decipher.update(encData), decipher.final()]);
  // 去 PKCS7 padding
  const pad = dec[dec.length - 1];
  if (pad && pad <= 16) dec = dec.subarray(0, dec.length - pad);
  const storedHash = dec.subarray(0, 64);
  const plaintext = dec.subarray(64);
  const computed = crypto.createHash("sha512").update(plaintext).digest();
  if (!storedHash.equals(computed)) throw new Error("Hash verification failed");
  return plaintext.toString("utf8");
}

/**
 * 读取某 storage.json 并返回账号认证对象。
 * @param {string} storagePath storage.json 绝对路径
 * @returns {{auth:object, deviceId:string, storagePath:string}}
 */
export function readAuthFromStorage(storagePath) {
  const data = JSON.parse(fs.readFileSync(storagePath, "utf8"));
  const enc = data["iCubeAuthInfo://icube.cloudide"];
  let auth;
  if (!enc) {
    throw new Error("storage.json 无 iCubeAuthInfo 键（可能未登录）");
  }
  if (enc.trim().startsWith("{")) {
    auth = JSON.parse(enc); // SG/明文版
  } else {
    auth = JSON.parse(decryptStorageValue(enc));
  }
  const deviceId =
    data["telemetry.devDeviceId"] || data["telemetry.machineId"] || data["telemetry.sqmId"] || null;
  const machineId = data["telemetry.machineId"] || null;
  return { auth, deviceId, machineId, storagePath };
}

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
