// src/compute/trae-storage.js - TRAE storage.json 的读取与解密（最底层，无项目内依赖）
// v1.12.6 从 trae-decrypt.js 下沉：readAuthFromStorage 只吃「一个路径字符串」，
// 只依赖 crypto/fs —— 而 trae-decrypt.readAccountAuth 需要 paths.js、paths.js 的
// 串号闸门又需要 readAuthFromStorage，形成 trae-decrypt ↔ paths 循环依赖
// （README 不变量：「分层单向、无循环依赖」；先例：gc 独立成模块解除 derive↔history 互引）。
// 下沉后：trae-storage <- {trae-decrypt, paths}，环断。算法来源不变：
// kenuoseclab/trae-local-api（AES-128-CBC），token 不落盘明文。
import crypto from "node:crypto";
import fs from "node:fs";

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
  // v1.9.3：x-device-id 必须与登录态**同源** —— `iCubeAuthInfo://icube-dc:<id>` 是登录时
  // 服务端登记的设备号；telemetry.devDeviceId 是**机器级**遥测 id（本机 6 个槽里 4 个共用
  // 同一个值）。用它打 `checkin_credits/claim` 会被 9074（"当前参与用户太多"）挡下，
  // 换 icube-dc id 同一秒即成功（2026-10-08 同秒 A/B 实测，见 CHANGELOG v1.9.3）。
  // devDeviceId 只作兜底（老槽没有 icube-dc 键时）。
  const _dcKey = Object.keys(data).find((k) => k.startsWith("iCubeAuthInfo://icube-dc:"));
  const deviceId =
    (_dcKey ? _dcKey.split(":").pop() : "") ||
    data["telemetry.devDeviceId"] || data["telemetry.machineId"] || data["telemetry.sqmId"] || null;
  const machineId = data["telemetry.machineId"] || null;
  return { auth, deviceId, machineId, storagePath };
}
