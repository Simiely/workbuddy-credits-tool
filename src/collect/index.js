// src/collect/index.js - 采集层出口（TRAE Work 版）
// TRAE 登录态采集 = 本地 storage.json 解密（无浏览器 cookie 采集）。
// 账号池由 scanLocalAuths 建立；此处仅提供状态与 WebDAV 账号池恢复（多设备镜像）。
import { importLegacy } from "../compute/store.js";
import { importLegacy as importHistory } from "../compute/history.js";

/** 采集方案信息（供状态接口/前端提示） */
export function collectorStatus() {
  return {
    scheme: "local",
    edgeAvailable: false,
    webdavAvailable: true,
    // TRAE 采集=解密本机登录态,无浏览器插件
    desc: "本地 TRAE 登录态解密",
  };
}

/**
 * 从 WebDAV 同步整个账号池（多设备镜像恢复）。下载后把遗留 JSON 镜像导入 SQLite。
 * @param {object} [cfg] WebDAV 配置（由 webdav.syncNow 内部处理，此函数供兼容）
 */
export async function syncFromWebDAV() {
  // TRAE 版：GUI 启动 / WebDAV 同步后，把下载的 trae-accounts.json 镜像导入 SQLite。
  importLegacy();
  importHistory();
  return { ok: true };
}
