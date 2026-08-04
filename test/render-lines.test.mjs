// test/render-lines.test.mjs — 积分消耗趋势回归（每日±20天窗口 / 全部显示 / 每月）
// 运行: node test/render-lines.test.mjs
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createFrontendEnv, loadFrontend, makeTester } from "./helpers/vm-env.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const ctx = createFrontendEnv({
  fetch: async () => ({ json: async () => ({ ok: true, results: [], per: [] }) }),
});
loadFrontend(ctx, ROOT);
const { run } = ctx;
const { assert, report } = makeTester();

// 构造只有「今天」一天数据的 dashPer(模拟沙箱现状:仅 8/4 有快照)
const today = new Date();
const todayIso = new Date(today.getFullYear(), today.getMonth(), today.getDate()).toISOString();
run(`
  dashPer = [{ uin: "u1", displayName: "小陈", series: [{ t: ${JSON.stringify(todayIso)}, v: 10 }], currentRemain: 100 }];
  dashMode = "day";
  renderLines();
`);
const dayHtml = run(`$("chart").innerHTML`);
const w0 = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 20);
const w1 = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 20);
const label = (d) => `${d.getMonth() + 1}月${d.getDate()}日`;

console.log("T1 每日视图: 数据 1 天 → 窗口下限 3 天(以今天为中心:昨天/今天/明天)");
const d1 = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
const dP1 = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);
assert(`左边界 = 昨天(${label(d1)})`, dayHtml.includes(label(d1)));
assert(`右边界 = 明天(${label(dP1)})`, dayHtml.includes(label(dP1)));
assert("不再补 ±20 天(7月15日不出现)", !dayHtml.includes("7月15日"));
assert("柱状图渲染(存在柱 rect)", (dayHtml.match(/<rect/g) || []).length >= 1);
assert("柱带 hover 数据(存在 cpt)", dayHtml.includes("class=\"cpt\""));
assert("最高柱标注数值(10 出现)", dayHtml.includes('font-weight="700">10<'), dayHtml.slice(0, 400));

console.log("T5 每日视图: 数据 15 天 → 窗口上限 10 天(今天-4 ~ 今天+5)");
const pts15 = [];
for (let i = 14; i >= 0; i--) {
  const dt = new Date(today.getFullYear(), today.getMonth(), today.getDate() - i);
  pts15.push({ t: dt.toISOString(), v: 10 + i });
}
run(`
  dashPer = [{ uin: "u1", displayName: "小陈", series: ${JSON.stringify(pts15)}, currentRemain: 100 }];
  dashMode = "day";
  renderLines();
`);
const day15Html = run(`$("chart").innerHTML`);
const dM4 = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 4);
const dM5 = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 5);
const dP5 = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 5);
assert(`左边界 = 今天-4(${label(dM4)})`, day15Html.includes(label(dM4)));
assert(`今天-5(${label(dM5)}) 超出窗口不出现`, !day15Html.includes(label(dM5)));
assert(`右边界 = 今天+5(${label(dP5)})`, day15Html.includes(label(dP5)));

console.log("T2 全部显示模式: 不再补窗口刻度,只用实际数据日期");
run(`changeMode("all")`);
const allHtml = run(`$("chart").innerHTML`);
assert("「全部显示」按钮已点亮", run(`$("btnAll").className`).includes("active"));
assert("窗口左边界刻度不再出现(无补全)", !allHtml.includes(label(w0)));
assert("数据点日期标签出现", allHtml.includes(label(today)));

console.log("T3 每月模式: 按月份聚合");
run(`changeMode("month")`);
const monHtml = run(`$("chart").innerHTML`);
assert("「每月」按钮点亮", run(`$("btnMonth").className`).includes("active"));
assert("X 轴为月份标签", monHtml.includes("月") && !monHtml.includes("日"));

console.log("T4 切回每日(按钮状态正确)");
run(`changeMode("day")`);
assert("「每日」按钮点亮", run(`$("btnDay").className`).includes("active"));
assert("其余按钮未点亮", !run(`$("btnAll").className`).includes("active") && !run(`$("btnMonth").className`).includes("active"));

// hero「今日已用」环比昨日(自然日)
console.log("T6 hero 今日已用 vs 昨日(上升)");
const yK = new Date(); yK.setDate(yK.getDate() - 1);
const yKStr = `${yK.getFullYear()}-${String(yK.getMonth() + 1).padStart(2, "0")}-${String(yK.getDate()).padStart(2, "0")}`;
run(`
  S = { results: [{ account: { id: "a1", uin: "u1" }, summary: { baseRemain: 5000, giftRemain: 0, baseUsed: 100, giftUsed: 0, giftCount: 0 }, expired: false, derived: { todayUsed: 548, dailyUsed: [{ day: ${JSON.stringify(yKStr)}, used: 60 }, { day: "2099-01-01", used: 548 }] } }] };
  renderHero();
`);
const heroUp = run(`$("hero").innerHTML`);
assert("今日 548 显示", heroUp.includes("548"));
assert("上升箭头 ↑488(548-60)", heroUp.includes("↑488"), heroUp.slice(0, 400));

console.log("T7 hero 今日已用 vs 昨日(下降)");
run(`
  S = { results: [{ account: { id: "a1", uin: "u1" }, summary: { baseRemain: 5000, giftRemain: 0, baseUsed: 100, giftUsed: 0, giftCount: 0 }, expired: false, derived: { todayUsed: 30, dailyUsed: [{ day: ${JSON.stringify(yKStr)}, used: 100 }] } }] };
  renderHero();
`);
const heroDown = run(`$("hero").innerHTML`);
assert("下降箭头 ↓70(100-30)", heroDown.includes("↓70"), heroDown.slice(0, 400));

console.log("T8 hero 昨天无记录 → 不显示箭头");
run(`
  S = { results: [{ account: { id: "a1", uin: "u1" }, summary: { baseRemain: 5000, giftRemain: 0, baseUsed: 100, giftUsed: 0, giftCount: 0 }, expired: false, derived: { todayUsed: 30, dailyUsed: [{ day: "2099-01-01", used: 100 }] } }] };
  renderHero();
`);
const heroNoY = run(`$("hero").innerHTML`);
assert("无昨天记录时无箭头(仅数值)", !heroNoY.includes("↑") && !heroNoY.includes("↓"));

console.log("T9 账号总览 renderDashTable 正常渲染(防 cell 未定义类回归)");
run(`
  dashPer = [{ uin: "u1", displayName: "小陈", todayUsed: 10, used: 5, currentRemain: 100, expiring1d: 1, expiring2d: 2, expiring3d: 3, expiring7d: 7, alerts: [] }];
  renderDashTable();
`);
const dtCards = run(`$("dashCards").innerHTML`);
const dtBody = run(`$("dashTbody").innerHTML`);
assert("卡片版渲染(含近2天/近7天过期标签)", dtCards.includes("近2天过期") && dtCards.includes("近7天过期"));
assert("表格版渲染(近2天数值 2 与近7天数值 7)", dtBody.includes(">2<") && dtBody.includes(">7<"));
assert("两张表都有内容(无未定义报错)", dtCards.length > 100 && dtBody.length > 100);

console.log("T10 柱状图:每组右侧隔一个柱宽画「当日合计」柱,标签给组内最高(合计)");
run(`
  dashPer = [
    { uin: "u1", displayName: "小陈", series: [{ t: ${JSON.stringify(todayIso)}, v: 30 }], currentRemain: 100 },
    { uin: "u2", displayName: "老王", series: [{ t: ${JSON.stringify(todayIso)}, v: 80 }], currentRemain: 100 },
  ];
  dashMode = "day";
  renderLines();
`);
const barHtml = run(`$("chart").innerHTML`);
assert("合计柱渲染(灰色 data-n=当日合计)", barHtml.includes('data-n="当日合计"'));
assert("合计柱顶部有「合计」标签说明", barHtml.includes(">合计<"), barHtml.slice(0, 500));
assert("合计柱值 110 顶部标数字", barHtml.includes('font-weight="700">110<'));
assert("单柱(80/30)不标数字", !barHtml.includes('font-weight="700">80<') && !barHtml.includes('font-weight="700">30<'));
assert("组内标签恰好 1 个(合计 110)", (barHtml.match(/font-weight="700">110<\/text>/g) || []).length === 1);
assert("账号柱带占当日百分比(80→72.7%)", barHtml.includes('data-pct="72.7"'));
assert("账号柱带占当日百分比(30→27.3%)", barHtml.includes('data-pct="27.3"'));
assert("合计柱 data-pct=100", barHtml.includes('data-pct="100"'));

process.exit(report() ? 0 : 1);
