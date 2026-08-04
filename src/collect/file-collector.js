// src/collect/file-collector.js - Docker/NAS 采集：从 WebDAV 同步整个账号池（原 HANDOFF §6 的 Docker 方案）
import fs from "node:fs";
import path from "node:path";
import { Collector } from "./Collector.js";
import { loadSyncConfig, downloadFile, BACKUP_DIR, SYNC_FILES } from "../compute/webdav.js";
import { TOOLS_DIR } from "../config.js";

export class FileCollector extends Collector {
  constructor() {
    super("file");
  }

  /** Docker 方案没有"读当前浏览器"的概念，不支持采集当前账号 */
  async captureCurrentAccount() {
    throw new Error("Docker 方案不支持「添加当前账号」，请通过 WebDAV 同步账号池");
  }

  /**
   * 从 WebDAV 下载 wb-accounts.json 等到本地，完成账号池同步（Docker 启动调用）。
   * @param {object} [cfg] WebDAV 配置（缺省读本地 wb-sync.json）
   * @returns {Promise<{count, restored}>}
   */
  async syncFromWebDAV(cfg) {
    const c = cfg || loadSyncConfig();
    if (!c || !c.user)
      throw new Error("未配置 WebDAV 账号，请先填写用户名密码并保存配置");
    const url = c.url || "http://192.168.2.1:6086/";
    const restored = [];
    for (const f of SYNC_FILES) {
      const content = await downloadFile(url, c.user, c.pass, BACKUP_DIR, f);
      if (content === null) continue;
      fs.writeFileSync(path.join(TOOLS_DIR, f), content, "utf8");
      restored.push(f);
    }
    return { count: restored.length, restored };
  }
}
