// src/config.js - 全局配置（集中管理路径与常量，不再用路径 hack）
import path from "node:path";
import { fileURLToPath } from "node:url";

// 路径双兼容:原生 ESM 用 import.meta.url(config.js 在 <root>/src/ 向上跳一级=项目根);
// SEA 单文件 exe(CJS bundle)用 __filename(指向 exe 路径,数据目录 = exe 所在目录,不再上跳)
const isSEA = typeof __filename !== "undefined";
const HERE = isSEA ? __filename : fileURLToPath(import.meta.url);
const __dirname = path.dirname(HERE);
export const ROOT = isSEA ? __dirname : path.resolve(__dirname, "..");
// 数据目录:默认=项目根(exe 版 = exe 所在目录);可用环境变量 WB_TOOLS_DIR 覆盖
// (本地预览/测试指向别的运行实例数据目录用,生产不设即原行为)
export const TOOLS_DIR = process.env.WB_TOOLS_DIR || ROOT;

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
