// src/collect/index.js - 采集层工厂与统一出口
// 计算层/展示层只从这里导入，不直接 import 具体 collector，从而与"桌面/容器"方案解耦。
import { COLLECTOR_SCHEME } from "../config.js";
import { EdgeCollector } from "./edge-collector.js";
import { FileCollector } from "./file-collector.js";
import { importLegacy } from "../compute/store.js";
import { importLegacy as importHistory } from "../compute/history.js";

export const scheme = COLLECTOR_SCHEME;
const edge = new EdgeCollector();
const file = new FileCollector();

/** 当前采集方案信息（供状态接口/前端提示） */
export function collectorStatus() {
  return {
    scheme,
    edgeAvailable: scheme === "edge",
    webdavAvailable: scheme === "file",
  };
}

/**
 * 采集当前账号（桌面 Edge 方案）。
 * @param {string} [remark] 备注名
 */
export async function captureCurrentAccount(remark) {
  if (scheme !== "edge")
    throw new Error(`当前方案(${scheme})不支持采集当前账号，请改用 WebDAV 同步`);
  return edge.captureCurrentAccount(remark);
}

/**
 * 从 WebDAV 同步整个账号池（Docker 启动方案）。
 * @param {object} [cfg] WebDAV 配置
 */
export async function syncFromWebDAV(cfg) {
  if (scheme !== "file")
    throw new Error(`当前方案(${scheme})不使用 WebDAV 同步`);
  const r = await file.syncFromWebDAV(cfg);
  // 下载完成后，把遗留 JSON 镜像导入 SQLite（新的唯一真相源）
  importLegacy();
  importHistory();
  return r;
}
