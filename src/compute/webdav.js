// src/compute/webdav.js - WebDAV 云同步（数据备份：上传/下载），原 lib/webdav.js
// 将账号池 + 历史快照备份到用户指定的 WebDAV（坚果云/Nextcloud 等）。
// 注:wb-last-data.json(最近一次刷新缓存,展示数据副本)不属于"账本"数据,不参与备份(v1.4.31)。
import fs from "node:fs";
import path from "node:path";
import { TOOLS_DIR } from "../config.js";

export const SYNC_FILE = path.join(TOOLS_DIR, "wb-sync.json"); // 本地同步配置（含密码，仅本机）
export const BACKUP_DIR = "workbuddy/workbuddy积分"; // WebDAV 上的备份目录（多级）
export const SYNC_FILES = ["wb-accounts.json", "wb-history.json"]; // 备份哪些本地文件(账本数据:账号池+历史)

export function loadSyncConfig() {
  try {
    return JSON.parse(fs.readFileSync(SYNC_FILE, "utf8"));
  } catch {
    return null;
  }
}
export function saveSyncConfig(cfg) {
  fs.writeFileSync(SYNC_FILE, JSON.stringify(cfg, null, 2), "utf8");
}

const auth = (user, pass) => "Basic " + Buffer.from(`${user}:${pass}`).toString("base64");

// 统一请求：网络超时/连接错误自动退避重试 2 次(穿透线路抖动时提高成功率)；登录失败/HTTP 错误不重试
// timeoutMs:小请求(建目录/测试)20s；上传/下载大文件(如 wb-history.json 3.6MB 走慢速穿透)给 60s
async function req(method, url, user, pass, body, timeoutMs = 20000) {
  for (let attempt = 0; ; attempt++) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const r = await fetch(url, {
        method,
        headers: {
          Authorization: auth(user, pass),
          ...(body ? { "Content-Type": "application/octet-stream" } : {}),
        },
        body,
        signal: ctrl.signal,
      });
      if (r.status === 401 || r.status === 403)
        throw new Error("WebDAV 登录失败：用户名或密码错误（HTTP " + r.status + " 未授权）");
      return r;
    } catch (e) {
      if (e.message.startsWith("WebDAV 登录失败")) throw e;
      const netErr = e.name === "AbortError" || e.message.startsWith("网络错误") || e.message.startsWith("WebDAV 请求超时");
      if (netErr && attempt < 2) {
        await new Promise((res) => setTimeout(res, 800 * (attempt + 1))); // 0.8s / 1.6s 退避
        continue;
      }
      throw new Error(e.name === "AbortError" ? `WebDAV 请求超时(${Math.round(timeoutMs / 1000)}s)` : "网络错误: " + e.message);
    } finally {
      clearTimeout(t);
    }
  }
}

const baseOf = (base) => base.replace(/\/+$/, "");
const fileUrl = (base, dir, file) => `${baseOf(base)}/${dir}/${file}`;

/** 确保备份目录存在：多级目录逐级 MKCOL（每级 201 新建 / 405·301 已存在均视为成功） */
export async function ensureDir(base, user, pass, dir = BACKUP_DIR) {
  const baseUrl = baseOf(base);
  let acc = "";
  for (const seg of String(dir).split("/").filter(Boolean)) {
    acc += "/" + seg;
    const r = await req("MKCOL", baseUrl + acc + "/", user, pass);
    if (![200, 201, 301, 405].includes(r.status))
      throw new Error("创建目录失败(HTTP " + r.status + ")");
  }
}

/** 上传单个文件（PUT），自动建目录。423(资源被锁,瞬时)退避重试 3 次；大文件给 60s 超时 */
export async function uploadFile(base, user, pass, dir, file, content) {
  await ensureDir(base, user, pass, dir);
  let lastStatus = 0;
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await req("PUT", fileUrl(base, dir, file), user, pass, content, 60000);
    if (r.status >= 200 && r.status < 300) return;
    if (r.status === 423 && attempt < 2) {
      await new Promise((res) => setTimeout(res, 1200 * (attempt + 1))); // 1.2s / 2.4s 退避
      continue;
    }
    lastStatus = r.status;
    break;
  }
  throw new Error(
    `上传 ${file} 失败(HTTP ${lastStatus})` +
      (lastStatus === 423 ? "：文件被服务器锁定(可能被其他程序/同步任务占用),请稍后重试" : "")
  );
}

/** 下载单个文件（GET）；404 返回 null。大文件给 60s 超时 */
export async function downloadFile(base, user, pass, dir, file) {
  const r = await req("GET", fileUrl(base, dir, file), user, pass, null, 60000);
  if (r.status === 404) return null;
  if (r.status >= 200 && r.status < 300) return await r.text();
  throw new Error(`下载 ${file} 失败(HTTP ${r.status})`);
}

/** 测试连接：建目录即可（成功或已存在都算通） */
export async function testConnection(base, user, pass) {
  await ensureDir(base, user, pass);
  return true;
}
