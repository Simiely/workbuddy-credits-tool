// src/collect/edge-collector.js - 桌面采集：经 edge-daemon 读本机 Edge 登录态（原 lib/cookies.js）
import { Collector } from "./Collector.js";
import { daemonTabs, daemonCmd, daemonEval } from "./daemon-client.js";

const SESSION_COOKIE_RE = /session/i;

/** 认证 session cookie 的最早过期时间（秒 → ISO 字符串） */
function minSessionExpiry(cookies) {
  const exps = cookies
    .filter((c) => SESSION_COOKIE_RE.test(c.name) && c.expires && c.expires > 0)
    .map((c) => c.expires);
  return exps.length ? new Date(Math.min(...exps) * 1000).toISOString() : null;
}

export class EdgeCollector extends Collector {
  constructor() {
    super("edge");
  }

  /** 采集当前 Edge 登录的 workbuddy/codebuddy cookie（原 getEdgeCookies） */
  async _getEdgeCookies() {
    const tabs = await daemonTabs();
    const tab = tabs.find((t) => t.url.includes("workbuddy.cn")) || tabs[0];
    if (!tab)
      throw new Error("浏览器里没有 workbuddy 页面,请先在 Edge 打开 https://www.workbuddy.cn 并登录");
    // 用 Network.getCookies 按当前页面 URL 精确取"浏览器真正会发送的 cookie":
    // 自动按 domain/path/secure 过滤并按名去重,不会混入 KC_RESTART(登录端点一次性令牌)、
    // 广告/埋点跟踪 cookie、其他会话残留 —— 旧实现 getAllCookies 会全量拼接导致
    // 请求头超限(stgw 400 Request Header Or Cookie Too Large,2026-08-06)。
    const r = await daemonCmd(tab.targetId, "Network.getCookies", { urls: [tab.url] });
    const cookies = (r.result && r.result.cookies) || [];
    if (!cookies.length) {
      // 兜底:getCookies 异常时回退 getAllCookies(仍会被 client.js 清洗)
      const r2 = await daemonCmd(tab.targetId, "Network.getAllCookies");
      cookies.push(...((r2.result && r2.result.cookies) || []));
    }
    const filtered = cookies.filter(
      (c) => c.domain.includes("workbuddy.cn") || c.domain.includes("codebuddy.cn")
    );
    if (!filtered.length) throw new Error("未找到 workbuddy 登录 cookie,请先登录");
    const cookieHeader = filtered.map((c) => `${c.name}=${c.value}`).join("; ");
    return { cookieHeader, sessionExpiresAt: minSessionExpiry(filtered) };
  }

  /** 尝试从 workbuddy 页面文本提取手机号（作为账号名），失败返回空串（原 phoneFromPage） */
  async _phoneFromPage() {
    try {
      const tabs = await daemonTabs();
      const idx = tabs.findIndex((t) => t.url.includes("workbuddy.cn"));
      if (idx < 0) return "";
      const expr =
        "document.body ? (document.body.innerText.match(/1[3-9]\\d{9}/)||[''])[0] : ''";
      return await daemonEval(expr, idx);
    } catch {
      return "";
    }
  }

  /**
   * 采集当前账号（桌面 Edge 方案）。
   * @param {string} [remark] 备注名（优先于页面提取的手机号）
   * @returns {Promise<{cookieHeader, sessionExpiresAt, name}>}
   */
  async captureCurrentAccount(remark) {
    const { cookieHeader, sessionExpiresAt } = await this._getEdgeCookies();
    const phone = (remark || "").trim() || (await this._phoneFromPage());
    return { cookieHeader, sessionExpiresAt, name: phone };
  }
}
