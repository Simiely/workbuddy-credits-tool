// src/present/render.js - 输出渲染层: markdown / CSV / 账号摘要（CLI 与 GUI 共用, TRAE Work 版）
// 统一消费 src/compute/model.js 的 parseEntitlementData。
// TRAE 口径：通用积分池(gift*) + 各可耗积分包(带过期 endTime) + 今日签到(checkin)。
import { cnNow } from "../time.js";
import { displayName } from "../compute/store.js";
import { parseEntitlementData } from "../compute/model.js";

/** 账号对外摘要(不暴露 storage/token,供 API/前端展示) */
export function brief(a) {
  return {
    id: a.id,
    name: a.name,
    displayName: a.displayName,
    uin: a.uin,
    appKey: a.appKey || "traework", // 软件来源(多软件积分标记,仅标识不涉敏)
    sessionExpiresAt: a.sessionExpiresAt,
  };
}

/** 凭证打码：日志/调试输出,避免明文泄漏 */
export function maskSecret(s) {
  s = s || "";
  if (s.length <= 8) return s ? "*".repeat(s.length) : "";
  return s.slice(0, 4) + "*".repeat(Math.max(4, s.length - 8)) + s.slice(-4);
}

/** 秒时间戳 → "YYYY-MM-DD HH:mm"(北京时间) 展示 */
function bj(ts) {
  if (!ts) return "长期/无";
  try {
    const d = new Date(ts * 1000);
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  } catch { return String(ts); }
}

/** 签到徽标 */
function signStr(checkedIn) {
  if (checkedIn === null || checkedIn === undefined) return "?";
  return checkedIn ? "✅ 已签到" : "⏰ 未签到";
}

/** 单包行 从原始 pack 提取展示 */
function packRow(p) {
  const inf = p.entitlement_base_info || {};
  const limit = inf.quota?.credits_limit ?? 0;
  const used = (p.usage && typeof p.usage.credits_amount === "number") ? p.usage.credits_amount : 0;
  return {
    desc: (p.display_desc || "积分").trim(),
    used, limit, remain: Math.max(0, limit - used),
    endTime: inf.end_time || null,
    expired: !((p.status === 0) && (inf.end_time || 0) > Math.floor(Date.now() / 1000)),
    currency: inf.currency,
  };
}

/** 给重复包描述加编号 */
function uniqLabels(rows) {
  const cnt = {};
  rows.forEach((r) => (cnt[r.desc] = (cnt[r.desc] || 0) + 1));
  const seen = {};
  return rows.map((r) => {
    seen[r.desc] = (seen[r.desc] || 0) + 1;
    r.label = cnt[r.desc] > 1 ? `${r.desc} ${seen[r.desc]}` : r.desc;
    return r;
  });
}

// ---------- markdown ----------

/** 单账号明细 markdown(输出到控制台)。D=TRAE entitlement data；checkin=签到对象 */
export function renderSingleMarkdown(D, checkin, showAll, account) {
  const m = parseEntitlementData(D);
  const ok = (n) => (n == null ? "-" : Math.round(n * 100) / 100);
  console.log(`# TRAE Work 积分查询(${cnNow()})`);
  if (account) console.log(`> 账号: ${displayName(account)} (${account.uin || "?"})`);
  console.log("");
  console.log("## 总览");
  console.log("");
  console.log("| 指标 | 数值 |");
  console.log("|---|---|");
  console.log(`| 通用积分池总额 | ${ok(m.giftSize)} |`);
  console.log(`| 已消耗 | ${ok(m.giftUsed)} |`);
  console.log(`| **可用剩余** | **${ok(m.giftRemain)}** |`);
  console.log(`| 可耗积分包 | ${m.giftCount} 个(含过期 ${m.expCount}) |`);
  console.log(`| 今日签到 | ${signStr(checkin && checkin.checked_in)}${checkin && checkin.credits ? ` (奖励 ${checkin.credits})` : ""} |`);
  console.log("");
  const rows = uniqLabels((m.packs || []).map(packRow));
  const shown = showAll ? rows : rows.filter((r) => !r.expired);
  console.log(`## ${showAll ? "全部积分包" : "有效积分包"}明细(${shown.length} 条)`);
  console.log("");
  console.log("| # | 包 | 已用/总量 | 剩余 | 到期时间 | 状态 |");
  console.log("|---|---|---|---|---|---|");
  shown
    .slice()
    .sort((a, b) => (a.endTime || 0) - (b.endTime || 0))
    .forEach((r, i) => {
      console.log(`| ${i + 1} | ${r.label} | ${ok(r.used)}/${ok(r.limit)} | ${ok(r.remain)} | ${bj(r.endTime)} | ${r.expired ? "已过期" : "有效"} |`);
    });
  console.log("");
  console.log("说明: TRAE CN 个人版官方不提供逐笔消耗明细,「各包余额/到期」为官方用量页最高粒度。");
}

/** 多账号总览 markdown(输出到控制台) */
export function renderAllMarkdown(results) {
  const t = cnNow();
  const okN = results.filter((r) => r.data).length;
  console.log(`# TRAE Work 多账号积分总览(${t})`);
  console.log("");
  console.log(`> 账号 ${okN}/${results.length} 查询成功`);
  console.log("");
  console.log("| # | 账号 | Uin | 池总量 | 已用 | 剩余 | 有效包 | 签到 | 状态 |");
  console.log("|---|---|---|---|---|---|---|---|---|");
  results.forEach((r, i) => {
    const ok = (n) => (n == null ? "-" : Math.round(n * 100) / 100);
    if (r.data) {
      const s = r.summary;
      const ck = r.checkin;
      console.log(
        `| ${i + 1} | ${displayName(r.account)} | ${r.account.uin || "?"} | ${ok(s.giftSize)} | ${ok(s.giftUsed)} | ${ok(s.giftRemain)} | ${s.giftCount} | ${signStr(ck && ck.checked_in)} | ✅ |`
      );
    } else {
      const st = r.expired ? "⚠️ 凭证过期" : "❌ " + (r.error || "失败");
      console.log(`| ${i + 1} | ${displayName(r.account)} | ${r.account.uin || "?"} | - | - | - | - | - | ${st} |`);
    }
  });
  console.log("");
  console.log("提示: 凭证失效账号请重新登录 TRAE 后运行 scan 更新");
}

// ---------- Markdown 报表(按账号分节) ----------
export function mdAll(results) {
  const t = cnNow();
  const okN = results.filter((r) => r.data).length;
  const ok = (n) => (n == null ? "-" : Math.round(n * 100) / 100);
  let out = `# TRAE Work 积分报表(${t})\n\n> ${okN}/${results.length} 个账号查询成功\n\n`;
  results.forEach((r, i) => {
    const nm = displayName(r.account);
    if (!r.data) {
      out += `## ${i + 1}. ${nm}(查询失败)\n\n> ${r.error || "未知错误"}\n\n---\n\n`;
      return;
    }
    const m = parseEntitlementData(r.data);
    const ck = r.checkin;
    out += `## ${i + 1}. ${nm}(Uin: ${r.account.uin || "?"})\n\n`;
    out += `### 总览\n\n| 指标 | 数值 |\n|---|---|\n`;
    out += `| 通用积分池总额 | ${ok(m.giftSize)} |\n`;
    out += `| 已消耗 | ${ok(m.giftUsed)} |\n`;
    out += `| **可用剩余** | **${ok(m.giftRemain)}** |\n`;
    out += `| 可耗积分包 | ${m.giftCount} 个(过期 ${m.expCount}) |\n`;
    out += `| 今日签到 | ${signStr(ck && ck.checked_in)}${ck && ck.credits ? ` (奖励 ${ck.credits})` : ""} |\n\n`;
    const rows = uniqLabels((m.packs || []).map(packRow)).filter((x) => !x.expired);
    out += `### 有效积分包(${rows.length} 条)\n\n| # | 包 | 已用/总量 | 剩余 | 到期时间 |\n|---|---|---|---|---|\n`;
    rows
      .slice()
      .sort((a, b) => (a.endTime || 0) - (b.endTime || 0))
      .forEach((x, j) => {
        out += `| ${j + 1} | ${x.label} | ${ok(x.used)}/${ok(x.limit)} | ${ok(x.remain)} | ${bj(x.endTime)} |\n`;
      });
    out += `\n---\n\n`;
  });
  return out;
}

// ---------- CSV ----------

/** 多账号 CSV 内容(带 BOM,Excel 中文不乱码) */
export function csvAll(results) {
  const head = "账号,Uin,包名,已用,总量,剩余,到期时间(北京),状态,签到";
  const lines = [];
  const ok = (n) => (n == null ? "-" : n);
  for (const r of results) {
    if (!r.data) {
      lines.push(
        [displayName(r.account), r.account.uin || "", "查询失败", "-", "-", "-", "-", r.error || "", ""].join(",")
      );
      continue;
    }
    const m = parseEntitlementData(r.data);
    const rows = uniqLabels((m.packs || []).map(packRow));
    const ck = r.checkin;
    for (const a of rows) {
      lines.push(
        [
          displayName(r.account),
          r.account.uin || "",
          a.label,
          ok(a.used),
          ok(a.limit),
          ok(a.remain),
          bj(a.endTime),
          a.expired ? "已过期" : "有效",
          signStr(ck && ck.checked_in),
        ].join(",")
      );
    }
  }
  return "﻿" + [head, ...lines].join("\n");
}

/** 单账号 CSV 内容(带 BOM) */
export function csvSingle(D) {
  const head = "包名,已用,总量,剩余,到期时间,状态";
  const m = parseEntitlementData(D);
  const ok = (n) => (n == null ? "-" : n);
  const lines = uniqLabels((m.packs || []).map(packRow)).map((a) =>
    [a.label, ok(a.used), ok(a.limit), ok(a.remain), bj(a.endTime), a.expired ? "已过期" : "有效"].join(",")
  );
  return "﻿" + [head, ...lines].join("\n");
}
