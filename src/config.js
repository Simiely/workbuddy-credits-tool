// src/config.js - 全局配置（集中管理路径与常量，不再用路径 hack）
import path from "node:path";
import { fileURLToPath } from "node:url";

// config.js 位于 <root>/src/，向上一级即项目根（wb-gui.mjs / wb-*.json 所在）
const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, "..");
export const TOOLS_DIR = ROOT; // 数据文件与旧版一致，仍在项目根

// ---------- 运行常量 ----------
export const CONCURRENCY = 6;       // 批量查询并发数
export const FETCH_TIMEOUT_MS = 8000; // 单账号请求 WorkBuddy 超时（毫秒）
export const DAEMON_PORT = 8129;    // edge-daemon 端口
export const GUI_PORT = 8080;       // GUI 服务端口

// ---------- 安全：管理员密码（写类接口保护） ----------
// 密码不再依赖环境变量，改为运行时由前端「首次设置密码」持久化到 wb-admin.json（默认未启用=开放）。

// WorkBuddy 计费接口（无公开文档，是网页自身使用的内部接口）
export const API = "https://www.workbuddy.cn/billing/meter/get-user-resource";
export const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36 Edg/148.0.0.0";

// 采集方案：环境变量显式指定优先；否则桌面(win32)用 Edge，其余（Docker/NAS/Linux）用 WebDAV 文件
export const COLLECTOR_SCHEME =
  process.env.WB_COLLECTOR && ["edge", "file"].includes(process.env.WB_COLLECTOR)
    ? process.env.WB_COLLECTOR
    : process.platform === "win32"
      ? "edge"
      : "file";
