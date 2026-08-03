// lib/webdav.js - WebDAV 云同步(数据备份:上传/下载)
// 将账号池 + 历史快照 + 最近缓存备份到用户指定的 WebDAV(坚果云/Nextcloud 等)。
import fs from "node:fs";
import path from "node:path";
import { TOOLS_DIR } from "./util.js";

export const SYNC_FILE = path.join(TOOLS_DIR, "wb-sync.json"); // 本地同步配置(含密码,仅本机)
export const BACKUP_DIR = "workbuddy/workbuddy积分";            // WebDAV 上的备份目录(多级)
export const SYNC_FILES = ["wb-accounts.json", "wb-history.json", "wb-last-data.json"]; // 备份哪些本地文件

export function loadSyncConfig() {
  try { return JSON.parse(fs.readFileSync(SYNC_FILE, "utf8")); } catch { return null; }
}
export function saveSyncConfig(cfg) {
  fs.writeFileSync(SYNC_FILE, JSON.stringify(cfg, null, 2), "utf8");
}

const auth = (user, pass) => "Basic " + Buffer.from(`${user}:${pass}`).toString("base64");

async function req(method, url, user, pass, body) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 15000);
  try {
    return await fetch(url, {
      method,
      headers: { Authorization: auth(user, pass), ...(body ? { "Content-Type": "application/octet-stream" } : {}) },
      body,
      signal: ctrl.signal,
    });
  } catch (e) {
    throw new Error(e.name === "AbortError" ? "WebDAV 请求超时(15s)" : "网络错误: " + e.message);
  } finally { clearTimeout(t); }
}

const baseOf = (base) => base.replace(/\/+$/, "");
const fileUrl = (base, dir, file) => `${baseOf(base)}/${dir}/${file}`;

/** 确保备份目录存在:多级目录逐级 MKCOL(每级 201 新建 / 405·301 已存在均视为成功) */
export async function ensureDir(base, user, pass, dir = BACKUP_DIR) {
  const baseUrl = baseOf(base);
  let acc = "";
  for (const seg of String(dir).split("/").filter(Boolean)) {
    acc += "/" + seg;
    const r = await req("MKCOL", baseUrl + acc + "/", user, pass);
    if (![200, 201, 301, 405].includes(r.status)) throw new Error("创建目录失败(HTTP " + r.status + ")");
  }
}

/** 上传单个文件(PUT),自动建目录 */
export async function uploadFile(base, user, pass, dir, file, content) {
  await ensureDir(base, user, pass, dir);
  const r = await req("PUT", fileUrl(base, dir, file), user, pass, content);
  if (r.status >= 200 && r.status < 300) return;
  throw new Error(`上传 ${file} 失败(HTTP ${r.status})`);
}

/** 下载单个文件(GET);404 返回 null */
export async function downloadFile(base, user, pass, dir, file) {
  const r = await req("GET", fileUrl(base, dir, file), user, pass);
  if (r.status === 404) return null;
  if (r.status >= 200 && r.status < 300) return await r.text();
  throw new Error(`下载 ${file} 失败(HTTP ${r.status})`);
}

/** 测试连接:建目录即可(成功或已存在都算通) */
export async function testConnection(base, user, pass) {
  await ensureDir(base, user, pass);
  return true;
}

