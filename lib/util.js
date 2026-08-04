// lib/util.js - 通用工具:路径、常量、配置
import path from "node:path";

// 本文件位于 tools/lib/ 下,两次 dirname 得到 tools/
const LIB_DIR = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
export const TOOLS_DIR = path.dirname(LIB_DIR);

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- 全局配置(集中在此,便于调整) ----------
export const CONCURRENCY = 6;          // 批量查询并发数
export const FETCH_TIMEOUT_MS = 8000;  // 单账号请求 WorkBuddy 超时
export const DAEMON_PORT = 8129;       // edge-daemon 端口(平台端口段 8100-8199 内,便于被 tools-center 托管)
export const GUI_PORT = 8080;          // GUI 服务端口(可顺延)
export const HISTORY_LIMIT = 500;      // 历史快照上限
