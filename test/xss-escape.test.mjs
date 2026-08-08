// test/xss-escape.test.mjs — 前端 XSS 转义回归（v1.4.45）
// 用 vm 环境真实加载 state + core + render + chart + ops,构造恶意 displayName,
// 验证所有 innerHTML 注入点输出的是转义实体而非原始 HTML。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createFrontendEnv } from "./helpers/vm-env.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

let passed = 0, failed = 0;
const assert = (n, c, x = "") => { if (c) { passed++; console.log("  PASS " + n); } else { failed++; console.log("  FAIL " + n + (x ? "  << " + x : "")); } };

// 恶意显示名:含 <img onerror> 与引号,验证全部渲染点
const EVIL = '<img src=x onerror="alert(1)"> & "x"';

const ctx = createFrontendEnv({});
for (const f of ["wb-gui.state.js", "wb-gui.core.js", "wb-gui.render.js", "wb-gui.chart.js", "wb-gui.ops.js"]) {
  ctx.run(fs.readFileSync(path.join(ROOT, f), "utf8"));
}
const { run } = ctx;

// 构造恶意账号对象(带 summary 正常 + 一个失败账号)
const evilAcct = {
  account: { id: "acc1", uin: "10001", displayName: EVIL, name: "恶意名" },
  summary: { baseRemain: 100, baseUsed: 50, baseSize: 200, giftRemain: 300, giftUsed: 20, giftSize: 400, giftCount: 2, baseCycleEnd: "2026-08-31" },
  derived: { todayUsed: 10, consumed: 30, signedInToday: true, expiring3d: 5, dailyUsed: [], series: [] },
  error: null,
};
const failAcct = {
  account: { id: "acc2", uin: "10002", displayName: EVIL, name: "恶意失败" },
  summary: null,
  derived: {},
  error: '<img src=x onerror="alert(2)">',
};

run(`S = ${JSON.stringify({ fetchedAt: "2026/08/08 12:00:00", results: [evilAcct, failAcct] })};`);

console.log("T1 renderCards 卡片名已转义(恶意显示名不产生 img 标签)");
run("renderCards();");
const gridHtml = ctx.el("grid").innerHTML;
assert("卡片名含转义实体 &lt;img", gridHtml.includes("&lt;img"), gridHtml.slice(0, 200));
assert("卡片名不含原始 <img", !gridHtml.includes("<img"), gridHtml.slice(0, 200));
assert("失败卡错误信息已转义", !gridHtml.includes('onerror="alert(2)"') && gridHtml.includes("&lt;img"));

console.log("T2 renderDashTable 手机卡片 + 桌面表格账号名已转义");
run(`dashPer = [ { uin:'10001', displayName:${JSON.stringify(EVIL)}, name:'恶意名', todayUsed:1, consumed:2, expiring1d:0, expiring2d:0, expiring3d:0, expiring7d:0, currentRemain:400 } ];`);
run("renderDashTable();");
const cardsHtml = ctx.el("dashCards").innerHTML;
const tbodyHtml = ctx.el("dashTbody").innerHTML;
assert("手机卡 dname 已转义", cardsHtml.includes("&lt;img") && !cardsHtml.includes("<img"), cardsHtml.slice(0, 200));
assert("表格账号列已转义", tbodyHtml.includes("&lt;img") && !tbodyHtml.includes("<img"), tbodyHtml.slice(0, 200));

console.log("T3 chart 图例账号名已转义");
run(`dashPer = [ { uin:'10001', displayName:${JSON.stringify(EVIL)}, name:'恶意名', series:[{t:'2026-08-08T00:00:00.000Z', v:5}] } ];`);
run("renderLines();");
const legendHtml = ctx.el("legend").innerHTML;
assert("图例已转义", legendHtml.includes("&lt;img") && !legendHtml.includes("<img"), legendHtml.slice(0, 200));

console.log("T4 openDetail / openRename 已转义");
run(`openDetail("acc1");`);
assert("明细标题已转义", ctx.el("mTitle").textContent.includes("&lt;img"), ctx.el("mTitle").textContent);
run(`openRename("acc1");`);
const renameHtml = ctx.el("smallBody").innerHTML;
assert("改名输入框 value 已转义", renameHtml.includes("&lt;img") && !renameHtml.includes('value="<img'), renameHtml.slice(0, 200));

console.log(`\n===== ${passed} passed, ${failed} failed =====`);
process.exit(failed ? 1 : 0);
