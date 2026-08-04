// src/present/render.js - 输出渲染层: markdown / CSV / 账号摘要(CLI 与 GUI 共用)
// 统一消费 src/compute/model.js 的 parseAccountData，不再各自重算 base/gift/active/expired。
import { displayName } from "../compute/store.js";
import { parseAccountData, SHORT_PKG } from "../compute/model.js";

export { SHORT_PKG };

// 固定中国时区(+8)格式化当前时间：不依赖进程时区（容器 UTC 时 toLocaleString 会错位显示）
// 与 derive.js 自然日口径一致，CLI/GUI 显示同一时刻
export function cnNow() {
  const d = new Date(Date.now() + 8 * 3600000); // 平移至 UTC+8 墙钟
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}/${p(d.getUTCMonth() + 1)}/${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}

/** 账号对外摘要(不暴露 cookie,供 API/前端展示) */
export function brief(a) {
  return {
    id: a.id,
    name: a.name,
    displayName: a.displayName,
    uin: a.uin,
    sessionExpiresAt: a.sessionExpiresAt,
  };
}

/**
 * 凭证打码：用于日志/调试输出，避免明文 cookie/token 泄漏。
 * 保留首尾各 4 位便于定位,中间一律 *。
 * @param {string} [s]
 * @returns {string}
 */
export function maskSecret(s) {
  s = s || "";
  if (s.length <= 8) return s ? "*".repeat(s.length) : "";
  return s.slice(0, 4) + "*".repeat(Math.max(4, s.length - 8)) + s.slice(-4);
}

// ---------- markdown ----------

/** 单账号明细 markdown(输出到控制台) */
export function renderSingleMarkdown(D, showExpired, account) {
  const m = parseAccountData(D);
  const base = m.base;
  const active = m.active;
  const expired = m.expired;
  const sum = (arr, k) => arr.reduce((s, a) => s + (a[k] || 0), 0);
  console.log(`# WorkBuddy 积分查询(${cnNow()})`);
  if (account) console.log(`> 账号: ${displayName(account)} (${account.uin || "?"})`);
  console.log("");
  console.log("## 总览");
  console.log("");
  console.log("| 类别 | 已用/总量 | 剩余 | 说明 |");
  console.log("|---|---|---|---|");
  if (base)
    console.log(
      `| 基础用量(${base.PackageName}) | ${base.CapacityUsed}/${base.CapacitySize} | ${base.CapacityRemain} | 当月有效 · 至 ${(base.CycleEndTime || "").slice(0, 10)} |`
    );
  console.log(
    `| 权益赠送包(有效) | ${sum(active, "CapacityUsed")}/${sum(active, "CapacitySize")} | ${sum(active, "CapacityRemain")} | ${active.length} 个包 |`
  );
  console.log(
    `| 赠送包(已过期) | ${sum(expired, "CapacityUsed")}/${sum(expired, "CapacitySize")} | 0 | ${expired.length} 个包 |`
  );
  console.log(
    `| **合计(全部) | ${sum(m.gifts, "CapacityUsed")}/${sum(m.gifts, "CapacitySize")} | ${sum(m.gifts, "CapacityRemain")} | 赠送总计 |`
  );
  console.log("");
  const rows = showExpired ? m.gifts : active;
  console.log(`## ${showExpired ? "全部赠送包" : "有效赠送包"}明细(${rows.length} 条)`);
  console.log("");
  console.log("| # | 包名 | 已用/总量 | 剩余 | 到期时间 | 状态 |");
  console.log("|---|---|---|---|---|---|");
  rows
    .slice()
    .sort((a, b) => (a.CycleEndTime < b.CycleEndTime ? -1 : 1))
    .forEach((a, i) => {
      console.log(
        `| ${i + 1} | ${SHORT_PKG(a.PackageName)} | ${a.CapacityUsed}/${a.CapacitySize} | ${a.CapacityRemain} | ${a.CycleEndTime} | ${a.Status === 0 ? "有效" : "已过期"} |`
      );
    });
}

/** 多账号总览 markdown(输出到控制台) */
export function renderAllMarkdown(results) {
  const t = cnNow();
  const okN = results.filter((r) => r.data).length;
  console.log(`# WorkBuddy 多账号积分总览(${t})`);
  console.log("");
  console.log(`> 账号 ${okN}/${results.length} 查询成功`);
  console.log("");
  console.log("| # | 账号 | Uin | 体验版剩余 | 赠送包已用/总量 | 赠送剩余 | 包数 | 状态 |");
  console.log("|---|---|---|---|---|---|---|---|");
  results.forEach((r, i) => {
    if (r.data) {
      const s = r.summary;
      console.log(
        `| ${i + 1} | ${displayName(r.account)} | ${r.account.uin || "?"} | ${s.baseRemain ?? "-"} | ${s.giftUsed}/${s.giftSize} | ${s.giftRemain} | ${s.giftCount} | ✅ |`
      );
    } else {
      const st = r.expired ? "⚠️ 凭证过期" : "❌ " + (r.error || "失败");
      console.log(
        `| ${i + 1} | ${displayName(r.account)} | ${r.account.uin || "?"} | - | - | - | - | ${st} |`
      );
    }
  });
  console.log("");
  console.log("提示: 凭证过期账号请重新登录后运行 save-current 更新");
}

// ---------- Markdown 报表 ----------

/** 多账号 Markdown 报表(按账号分节,含总览+有效赠送包明细) */
export function mdAll(results) {
  const t = cnNow();
  const okN = results.filter((r) => r.data).length;
  let out = `# WorkBuddy 积分报表(${t})\n\n> ${okN}/${results.length} 个账号查询成功\n\n`;
  results.forEach((r, i) => {
    const nm = displayName(r.account);
    if (!r.data) {
      out += `## ${i + 1}. ${nm}(查询失败)\n\n> ${r.error || "未知错误"}\n\n---\n\n`;
      return;
    }
    const m = parseAccountData(r.data);
    const base = m.base;
    const active = m.active;
    const expired = m.expired;
    const sum = (arr, k) => arr.reduce((s, a) => s + (a[k] || 0), 0);
    out += `## ${i + 1}. ${nm}(Uin: ${r.account.uin || "?"})\n\n`;
    out += `### 总览\n\n| 类别 | 已用/总量 | 剩余 | 说明 |\n|---|---|---|---|\n`;
    if (base)
      out += `| 基础用量(${base.PackageName}) | ${base.CapacityUsed}/${base.CapacitySize} | ${base.CapacityRemain} | 当月有效 · 至 ${(base.CycleEndTime || "").slice(0, 10)} |\n`;
    out += `| 权益赠送包(有效) | ${sum(active, "CapacityUsed")}/${sum(active, "CapacitySize")} | ${sum(active, "CapacityRemain")} | ${active.length} 个包 |\n`;
    out += `| 赠送包(已过期) | ${sum(expired, "CapacityUsed")}/${sum(expired, "CapacitySize")} | 0 | ${expired.length} 个包 |\n`;
    out += `| **合计(全部) | ${sum(m.gifts, "CapacityUsed")}/${sum(m.gifts, "CapacitySize")} | ${sum(m.gifts, "CapacityRemain")} | 赠送总计 |\n\n`;
    out += `### 有效赠送包(${active.length} 条)\n\n| # | 包名 | 已用/总量 | 剩余 | 到期时间 |\n|---|---|---|---|---|\n`;
    active
      .slice()
      .sort((a, b) => (a.CycleEndTime < b.CycleEndTime ? -1 : 1))
      .forEach((a, i) => {
        out += `| ${i + 1} | ${SHORT_PKG(a.PackageName)} | ${a.CapacityUsed}/${a.CapacitySize} | ${a.CapacityRemain} | ${a.CycleEndTime} |\n`;
      });
    out += `\n---\n\n`;
  });
  return out;
}

// ---------- CSV ----------

/** 多账号 CSV 内容(带 BOM,Excel 中文不乱码) */
export function csvAll(results) {
  const head = "账号,Uin,包名,已用,总量,剩余,周期开始,周期结束,状态";
  const lines = [];
  for (const r of results) {
    if (!r.data) {
      lines.push(
        [displayName(r.account), r.account.uin || "", "查询失败", "-", "-", "-", "-", "-", r.error || ""].join(",")
      );
      continue;
    }
    for (const a of r.data.Accounts) {
      lines.push(
        [
          displayName(r.account),
          r.account.uin || "",
          a.PackageName,
          a.CapacityUsed,
          a.CapacitySize,
          a.CapacityRemain,
          a.CycleStartTime,
          a.CycleEndTime,
          a.Status === 0 ? "有效" : "已过期",
        ].join(",")
      );
    }
  }
  return "﻿" + [head, ...lines].join("\n");
}

/** 单账号 CSV 内容(带 BOM) */
export function csvSingle(D) {
  const head = "名称,已用,总量,剩余,周期开始,周期结束,状态";
  const lines = D.Accounts.map((a) =>
    [a.PackageName, a.CapacityUsed, a.CapacitySize, a.CapacityRemain, a.CycleStartTime, a.CycleEndTime, a.Status].join(",")
  );
  return "﻿" + [head, ...lines].join("\n");
}
