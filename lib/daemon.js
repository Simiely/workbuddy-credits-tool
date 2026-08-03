// lib/daemon.js - 本地浏览器代理(edge-daemon.mjs)的 HTTP 客户端
// 代理持有一条持久 CDP 连接,免去每次操作的授权弹窗。端口见 lib/util.js DAEMON_PORT。
import { DAEMON_PORT } from "./util.js";
const DAEMON = `http://127.0.0.1:${DAEMON_PORT}`;

/** 列出代理可见的页面(页面级 target) */
export async function daemonTabs() {
  const r = await fetch(`${DAEMON}/tabs`);
  return r.json();
}

/** 在指定 targetId 上执行 CDP 命令(自动 attach) */
export async function daemonCmd(targetId, method, params = {}) {
  const r = await fetch(`${DAEMON}/cmd`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ method, params, targetId }),
  });
  return r.json();
}

/** 在页面(默认第一个 workbuddy 页面)执行 JS,返回字符串结果 */
export async function daemonEval(expr, targetIdx = 0) {
  const r = await fetch(`${DAEMON}/eval?target=${targetIdx}&expr=${encodeURIComponent(expr)}`);
  const j = await r.json();
  if (j.result && j.result.result && j.result.result.value !== undefined) return j.result.result.value;
  throw new Error("页面执行 JS 无返回值或失败");
}
