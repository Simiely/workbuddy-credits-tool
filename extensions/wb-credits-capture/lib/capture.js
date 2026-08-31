// lib/capture.js — 抓取:读 Cookie → 验证 → 组装账号记录(支持抓取时填名称作为备注)
import { sanitizeCookieHeader } from "./cookies.js";
import { loadRemark, saveRemark, loadAccounts, persistAccounts } from "./store.js";

const API = "https://www.workbuddy.cn/billing/meter/get-user-resource";
const REFERER = "https://www.workbuddy.cn/profile/plans-usage";

/** session cookie 的最早过期时间(秒 → ISO);无则 null(与工具 edge-collector 的 minSessionExpiry 同口径) */
function minSessionExpiry(cookies) {
  const exps = cookies
    .filter((c) => /session/i.test(c.name) && c.expires && c.expires > 0)
    .map((c) => c.expires);
  return exps.length ? new Date(Math.min(...exps) * 1000).toISOString() : null;
}

export async function capture(name) {
  // 全域名树采集(对齐工具 edge-collector 的 domain.includes 口径):
  // 覆盖 .workbuddy.cn / www.workbuddy.cn / host-only workbuddy.cn,避免漏采
  const cookies = await chrome.cookies.getAll({ domain: "workbuddy.cn" });
  if (!cookies.length) throw new Error("未获取到 workbuddy.cn 的 Cookie(未登录或未授予站点权限)");
  const filtered = cookies.filter((c) => c.domain.includes("workbuddy.cn"));
  if (!filtered.length) throw new Error("未找到 workbuddy.cn 登录 Cookie");
  // 清洗:剔除一次性登录/埋点垃圾 cookie + 同名去重 + 超长降级白名单(对齐工具 client.js)
  // 验证请求与落库前都必须是清洗后的 header,否则扩展内验证直接撞 400 Cookie Too Large
  const cookieHeader = sanitizeCookieHeader(filtered.map((c) => `${c.name}=${c.value}`).join("; "));

  // 验证 + 拿 Uin(与工具 client.js 同款请求;扩展 fetch 带浏览器 UA/TLS,不受 UA 风控)
  const resp = await fetch(API, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: cookieHeader,
      Referer: REFERER,
    },
    body: "{}",
  });
  if (resp.status === 401 || resp.status === 403)
    throw new Error(`Cookie 无效(HTTP ${resp.status}),请确认已在浏览器登录 workbuddy.cn`);
  let j;
  try { j = await resp.json(); } catch {
    throw new Error("billing 接口响应异常,可能官方接口变更(HTTP " + resp.status + ")");
  }
  if (j.code !== 0) throw new Error("billing 接口错误: " + (j.msg || JSON.stringify(j).slice(0, 120)));
  const data = (j.data && j.data.Response && j.data.Response.Data) || {};
  const first = (data.Accounts && data.Accounts[0]) || {};
  const uin = String(first.Uin || "");
  if (!uin) throw new Error("billing 响应中未找到账号标识(Uin)");

  const now = new Date().toISOString();
  // 抓取时填写的名称作为备注;留空则回退到该账号此前已设置的备注(避免重复抓取把备注顶掉),都没有则用默认名
  const remark = String(name || "").trim() || (await loadRemark(uin));
  const rec = {
    id: null, // 合并时决定(已有保留,新增生成)
    name: remark || "账号" + uin.slice(-4),
    remarkSet: !!remark, // 是否用户手动设置过备注(合并时避免覆盖远端已有备注的判断)
    uin,
    cookieHeader,
    userAgent: navigator.userAgent || "",
    sessionExpiresAt: minSessionExpiry(filtered),
    displayName: "",
    lastStatus: "ok",
    source: "extension",
    addedAt: now,
    updatedAt: now,
    lastTotal: data.TotalCount,
    lastDosage: data.TotalDosage,
    capturedAt: now,
  };
  if (remark) await saveRemark(uin, remark);
  // 归入账号列表(按 uin 覆盖已有,保持展示一张卡片/账号)
  const accounts = await loadAccounts();
  const idx = accounts.findIndex((a) => a && String(a.uin) === uin);
  if (idx >= 0) accounts[idx] = { ...accounts[idx], ...rec, id: accounts[idx].id };
  else accounts.push(rec);
  await persistAccounts(accounts);
  return { rec, total: data.TotalCount, dosage: data.TotalDosage, accounts };
}