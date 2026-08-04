// src/collect/daemon-client.js - 浏览器桥客户端(双模式)
// 平台托管模式:被 tools-center 加载并声明 browser 能力 → 走平台浏览器桥(懒加载)
//   环境变量由平台装配器注入: CAP_ENSURE_EP(能力 ensure 端点) / CAP_BROWSER_BASE(能力基址)
// 独立模式:无平台注入 → 直连本地 edge-daemon(DAEMON_PORT)
// 两种模式 API 契约一致(tabs/cmd/eval),上层代码无需感知。
// (浏览器桥双模式来自远程 74c2a32,合并进 src/ 结构)
import { DAEMON_PORT } from "../config.js";

async function browserBase() {
  const ensureEp = process.env.CAP_ENSURE_EP;
  if (ensureEp) {
    // 平台浏览器桥:懒加载触发(首次调用启动能力模块)
    const r = await fetch(ensureEp + "browser/ensure", { method: "POST" });
    const j = await r.json();
    if (!j.ok) throw new Error(j.error || "浏览器桥启动失败");
    return j.base || process.env.CAP_BROWSER_BASE || "";
  }
  return `http://127.0.0.1:${DAEMON_PORT}`;
}

/** 列出浏览器桥可见的页面(页面级 target) */
export async function daemonTabs() {
  const r = await fetch(`${await browserBase()}/tabs`);
  return r.json();
}

/** 在指定 targetId 上执行 CDP 命令(自动 attach) */
export async function daemonCmd(targetId, method, params = {}) {
  const r = await fetch(`${await browserBase()}/cmd`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ method, params, targetId }),
  });
  return r.json();
}

/** 在页面(默认第一个 workbuddy 页面)执行 JS,返回字符串结果 */
export async function daemonEval(expr, targetIdx = 0) {
  const r = await fetch(`${await browserBase()}/eval?target=${targetIdx}&expr=${encodeURIComponent(expr)}`);
  const j = await r.json();
  if (j.result && j.result.result && j.result.result.value !== undefined)
    return j.result.result.value;
  throw new Error("页面执行 JS 无返回值或失败");
}
