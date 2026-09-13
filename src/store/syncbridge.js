// src/store/syncbridge.js - 同步文件清单收敛（P1）
//
// 三处过去各写死文件名/清单（store.ACCOUNTS_FILE、history 内联 trae-history.json、
// webdav.SYNC_FILES），一旦改动会静默漂移（导出/上传文件的路径与清单不一致）。
// 现在收敛为唯一真源：导出/导入/上传/下载全引用同一份路径与清单，杜绝文件清单漂移。
import path from "node:path";
import { TOOLS_DIR } from "../config.js";

/** 账号池镜像（SQLite accounts + tombstones → JSON，供 WebDAV 上传/下载） */
export const ACCOUNTS_FILE = path.join(TOOLS_DIR, "trae-accounts.json");

/** 历史镜像（readings + day_summary → JSON，供 WebDAV 上传/下载） */
export const HISTORY_FILE = path.join(TOOLS_DIR, "trae-history.json");

/** 同步的账本文件清单（相对 TOOLS_DIR 的文件名），体现「哪些是账本数据」 */
export const SYNC_FILES = ["trae-accounts.json", "trae-history.json"];