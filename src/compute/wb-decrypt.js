// src/compute/wb-decrypt.js - WorkBuddy $wbEncrypted 凭证字段解密（sym-v1 / AES-256-GCM）
//
// 状态：实验性（待验证）。2026-09 新版 WorkBuddy 客户端把 .info 内 accessToken/refreshToken/
// nickname/phoneNumber 等字段加密为 {"$wbEncrypted":1,"envelope":"<base64>"}。
// envelope = {suite:1, keyId, nonce, authTag, ciphertext}，AES-256-GCM，密钥 = 本机
// at-rest symmetricKey（keyId 由密钥 SHA-256 前 16 字节派生）。
// 密钥为运行时注入、不随代码分发：从环境变量 WB_ATREST_KEY(base64) 或
// TOOLS_DIR/wb-atrest-key.json 读取（后者用 tools/wb-keygen.py 生成，不入库）。
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { TOOLS_DIR } from "../config.js";

const AAD_DOMAIN = Buffer.from("WB-AAD\0", "ascii");
const FRAMING_CODE = { file: 1, field: 2 };
const STANDARD_FORMAT_ID = { file: "WBEF1", field: "WBEV1" };
export const WB_ATREST_KEY_FILE = "wb-atrest-key.json";

function encodeUint32(v) {
  const b = Buffer.allocUnsafe(4);
  b.writeUInt32BE(v);
  return b;
}
function encodeLengthPrefixed(v) {
  const b = Buffer.from(v, "utf8");
  return Buffer.concat([encodeUint32(b.length), b]);
}
/** sym-v1 field 框架 AAD（与客户端 at-rest 模块 buildAuthenticatedContextAad 一致） */
export function buildSymFieldAad(keyId, suite) {
  return Buffer.concat([
    AAD_DOMAIN,
    Buffer.from([1]),
    encodeLengthPrefixed(STANDARD_FORMAT_ID.field),
    encodeLengthPrefixed("sym-v1"),
    encodeUint32(suite),
    encodeLengthPrefixed(keyId),
    Buffer.from([FRAMING_CODE.field]),
    Buffer.from([0]),
    Buffer.from([0]),
  ]);
}

/** 判定值是否为 $wbEncrypted 加密字段 */
export const isWbEncrypted = (v) =>
  v !== null && typeof v === "object" && v.$wbEncrypted === 1 && typeof v.envelope === "string";

/** 解析本机 at-rest symmetricKey（32 字节）。env 优先，其次密钥文件；找不到抛带指引的错误。 */
export function resolveAtRestKey() {
  if (process.env.WB_ATREST_KEY) {
    return Buffer.from(process.env.WB_ATREST_KEY, "base64");
  }
  const f = path.join(TOOLS_DIR, WB_ATREST_KEY_FILE);
  const readKeyFile = () => {
    try {
      const j = JSON.parse(fs.readFileSync(f, "utf8"));
      if (j && typeof j.symmetricKeyB64 === "string" && j.symmetricKeyB64) {
        return Buffer.from(j.symmetricKeyB64, "base64");
      }
    } catch {
      /* key 文件损坏/为空 → 视同不存在，走自动提取 */
    }
    return null;
  };
  let key = readKeyFile();
  if (key) return key;

  // v0.9.1：key 文件缺失/损坏时**自动重新提取**（把 wb-keygen.py 的能力做进程序，
  // 不再要求用户手动跑脚本）。仅本机可行（Windows + 已登录 WorkBuddy），失败则
  // 落回原错误提示。每进程最多尝试一次，避免反复拉起子进程。
  if (!resolveAtRestKey._tried) {
    resolveAtRestKey._tried = true;
    const keygen = path.join(TOOLS_DIR, "tools", "wb-keygen.py");
    if (fs.existsSync(keygen)) {
      console.error(
        `[wb-decrypt] 未找到 ${WB_ATREST_KEY_FILE}，自动运行 wb-keygen.py 提取本机密钥…`
      );
      const attempts = [
        ["python", [keygen, "--out", f]],
        ["py", ["-3", keygen, "--out", f]],
      ];
      for (const [exe, args] of attempts) {
        try {
          execFileSync(exe, args, { stdio: "inherit", timeout: 180000 });
          break;
        } catch {
          /* 试下一个解释器（ENOENT/失败都算） */
        }
      }
      key = readKeyFile();
      if (key) return key;
    }
  }
  throw new Error(
    `WorkBuddy 凭证已加密($wbEncrypted)但未配置解密密钥：` +
      `设置环境变量 WB_ATREST_KEY(base64) 或运行 tools/wb-keygen.py 生成 ${WB_ATREST_KEY_FILE}`
  );
}

/** 解密单个 envelope → 明文 UTF-8 字符串。GCM 认证失败（密钥/上下文不符）会抛错。 */
export function decryptWbField(envelope, key) {
  let env;
  try {
    env = JSON.parse(Buffer.from(envelope, "base64").toString("utf8"));
  } catch {
    throw new Error("非法 $wbEncrypted envelope(base64/JSON)");
  }
  if (
    typeof env.suite !== "number" ||
    typeof env.keyId !== "string" ||
    typeof env.nonce !== "string" ||
    typeof env.authTag !== "string" ||
    typeof env.ciphertext !== "string"
  ) {
    throw new Error("非法 $wbEncrypted envelope(缺字段)");
  }
  const d = crypto.createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(env.nonce, "base64"),
    { authTagLength: 16 }
  );
  d.setAAD(buildSymFieldAad(env.keyId, env.suite));
  d.setAuthTag(Buffer.from(env.authTag, "base64"));
  return Buffer.concat([
    d.update(Buffer.from(env.ciphertext, "base64")),
    d.final(),
  ]).toString("utf8");
}

/** 解密 .info 全文里所有 $wbEncrypted 字段 → 深拷贝明文 JSON（原 raw 不动）。 */
export function decryptWbInfo(raw, key) {
  let j;
  try {
    j = JSON.parse(raw);
  } catch {
    throw new Error(".info 非合法 JSON");
  }
  const out = JSON.parse(JSON.stringify(j));
  (function walk(o) {
    if (!o || typeof o !== "object") return;
    for (const k of Object.keys(o)) {
      const v = o[k];
      if (isWbEncrypted(v)) {
        o[k] = decryptWbField(v.envelope, key);
      } else if (v && typeof v === "object") {
        walk(v);
      }
    }
  })(out);
  return out;
}
