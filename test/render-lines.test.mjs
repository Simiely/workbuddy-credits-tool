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

console.log("T18 启动默认: 截止日期=今天,输入框同步显示(启动段 v1.4.60)");
const defToday = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
assert(`trendEnd 默认 = 今天`, run(`trendEnd`) === defToday, "got " + run(`trendEnd`));
assert(`输入框默认显示今天`, run(`$("trendEnd").value`) === defToday);

run(`
  dashPer = [{ uin: "u1", displayName: "小陈", series: [{ t: ${JSON.stringify(todayIso)}, v: 10 }], currentRemain: 100 }];
  dashMode = "day";
  trendEnd = ""; // 清空截止日期 → 动态窗口(数据少时下限 3 天补未来)
  renderLines();
`);
const dayHtml = run(`$("chart").innerHTML`);
const w0 = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 20);
const w1 = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 20);
const label = (d) => `${d.getMonth() + 1}月${d.getDate()}日`;

console.log("T1 每日视图(清空截止日期=动态窗口): 数据 1 天 → 窗口下限 3 天(从最早数据日=今天向右延伸:今天/明天/后天)");
const dP1 = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);
const dP2 = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 2);
assert(`左边界 = 今天(${label(today)})`, dayHtml.includes(label(today)));
assert(`右边界 = 今天+2(${label(dP2)})`, dayHtml.includes(label(dP2)));
assert("不再补 ±20 天(7月15日不出现)", !dayHtml.includes("7月15日"));
assert("柱状图渲染(存在柱 rect)", (dayHtml.match(/<rect/g) || []).length >= 1);
assert("柱带 hover 数据(存在 cpt)", dayHtml.includes("class=\"cpt\""));
assert("最高柱标注数值(10 出现)", dayHtml.includes('font-weight="700">10<'), dayHtml.slice(0, 400));

console.log("T5 每日视图: 数据 15 天 → 窗口上限 5 天(取最近 5 天:今天-4 ~ 今天)");
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
assert(`左边界 = 今天-4(${label(dM4)})`, day15Html.includes(label(dM4)));
assert(`今天-5(${label(dM5)}) 超出窗口不出现`, !day15Html.includes(label(dM5)));
assert(`右边界 = 今天(${label(today)})`, day15Html.includes(label(today)));

console.log("T8 截止日期选择: trendEnd=今天-10 → 固定窗口 5 天(今天-14 ~ 今天-10),以所选日为终点向前取");
const dE = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 10);
const ts10 = `${dE.getFullYear()}-${String(dE.getMonth() + 1).padStart(2, "0")}-${String(dE.getDate()).padStart(2, "0")}`;
const dE0 = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 14); // 终点-4 = 左边界
const dE1 = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 9);  // 终点之后,应不出现
const dS4 = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 6);  // 更晚日期,同样在窗口外
run(`
  trendEnd = ${JSON.stringify(ts10)};
  dashMode = "day";
  renderLines();
`);
const dayEndHtml = run(`$("chart").innerHTML`);
assert(`右边界 = 今天-10(${label(dE)})`, dayEndHtml.includes(label(dE)));
assert(`左边界 = 今天-14(${label(dE0)})`, dayEndHtml.includes(label(dE0)));
assert(`今天-9(${label(dE1)}) 超出截止窗口不出现`, !dayEndHtml.includes(label(dE1)));
assert(`今天-6(${label(dS4)}) 超出截止窗口不出现`, !dayEndHtml.includes(label(dS4)));

console.log("T9 清空截止日期 → 恢复默认动态窗口(仍为最近 5 天)");
run(`
  trendEnd = "";
  renderLines();
`);
const dayResetHtml = run(`$("chart").innerHTML`);
assert(`恢复后左边界 = 今天-4(${label(dM4)})`, dayResetHtml.includes(label(dM4)));
assert(`恢复后今天-5(${label(dM5)}) 不出现`, !dayResetHtml.includes(label(dM5)));

console.log("T10 「每日」按钮(onDayClick): 截止日期重置为今天 → 窗口 = 今天-4 ~ 今天,输入框同步");
const todayStrLocal = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
run(`
  trendEnd = ${JSON.stringify(ts10)};
  dashMode = "all";
  onDayClick();
`);
const dayClickHtml = run(`$("chart").innerHTML`);
assert(`trendEnd 已重置为今天(${todayStrLocal})`, run(`trendEnd`) === todayStrLocal);
assert(`输入框同步显示今天`, run(`$("trendEnd").value`) === todayStrLocal);
assert(`每日按钮点亮`, run(`$("btnDay").className`).includes("active"));
assert(`右边界 = 今天(${label(today)})`, dayClickHtml.includes(label(today)));
assert(`左边界 = 今天-4(${label(dM4)})`, dayClickHtml.includes(label(dM4)));
assert(`今天-5(${label(dM5)}) 不出现`, !dayClickHtml.includes(label(dM5)));

console.log("T11 非每日模式下选截止日期: 自动切每日且不覆盖所选日期");
run(`
  trendEnd = "";
  dashMode = "all";
  onTrendEnd(${JSON.stringify(ts10)});
`);
const dayAutoHtml = run(`$("chart").innerHTML`);
assert(`trendEnd 保留所选(${ts10})`, run(`trendEnd`) === ts10);
assert(`每日按钮点亮`, run(`$("btnDay").className`).includes("active"));
assert(`右边界 = 今天-10(${label(dE)})`, dayAutoHtml.includes(label(dE)));
assert(`左边界 = 今天-14(${label(dE0)})`, dayAutoHtml.includes(label(dE0)));
run(`trendEnd = ""; dashMode = "day"; renderLines();`); // 重置状态,避免污染后续用例

console.log("T12 「每月」按钮(onMonthClick): 截止月重置为当月 → 月窗口 = 当月-4 ~ 当月,输入框同步");
const curM = today.getMonth() + 1; // 当月(1-12)
const m0 = `${curM - 4 <= 0 ? 12 + (curM - 4) : curM - 4}月`; // 当月-4(跨年取模)
const m5 = `${curM - 5 <= 0 ? 12 + (curM - 5) : curM - 5}月`; // 当月-5(窗口外)
const mSer = [];
for (let i = 7; i >= 0; i--) { // 跨 8 个月数据:当月-7 ~ 当月(保证窗口内 ≥5 个月,不触发收缩)
  const dt = new Date(today.getFullYear(), today.getMonth() - i, 15);
  mSer.push({ t: dt.toISOString(), v: 10 + i });
}
run(`
  dashPer = [{ uin: "u1", displayName: "小陈", series: ${JSON.stringify(mSer)}, currentRemain: 100 }];
  trendEnd = "";
  dashMode = "day";
  onMonthClick();
`);
const monWinHtml = run(`$("chart").innerHTML`);
assert(`trendEnd 已重置为今天`, run(`trendEnd`) === todayStrLocal);
assert(`输入框同步显示今天`, run(`$("trendEnd").value`) === todayStrLocal);
assert(`每月按钮点亮`, run(`$("btnMonth").className`).includes("active"));
assert(`右边界 = ${curM}月`, monWinHtml.includes(`${curM}月`));
assert(`左边界 = 当月-4(${m0})`, monWinHtml.includes(m0), monWinHtml.slice(0, 300));
assert(`当月-5(${m5}) 不出现`, !monWinHtml.includes(m5));
assert(`当月+1(${(curM % 12) + 1}月) 不出现`, !monWinHtml.includes(`${(curM % 12) + 1}月`));

console.log("T13 清空截止日期 → 每月恢复全部月份(无窗口)");
const dMin = new Date(today.getFullYear(), today.getMonth() - 7, 1); // mSer 最早月(全量)
const dMid = new Date(today.getFullYear(), today.getMonth() - 3, 1); // 全量中间月
run(`
  trendEnd = "";
  changeMode("month");
`);
const monAllHtml = run(`$("chart").innerHTML`);
assert(`全量最早月(${dMin.getMonth() + 1}月) 出现(无窗口)`, monAllHtml.includes(`${dMin.getMonth() + 1}月`));
assert(`全量中间月(${dMid.getMonth() + 1}月) 出现`, monAllHtml.includes(`${dMid.getMonth() + 1}月`));
assert(`当月(${curM}月) 出现`, monAllHtml.includes(`${curM}月`));
assert(`当月+1(${(curM % 12) + 1}月) 不出现(无数据)`, !monAllHtml.includes(`${(curM % 12) + 1}月`));

console.log("T14 手动收缩(日): 数据仅今天 1 天 + trendEnd=今天 → 只画今天,无空刻度");
const dM1 = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
run(`
  dashPer = [{ uin: "u1", displayName: "小陈", series: [{ t: ${JSON.stringify(todayIso)}, v: 10 }], currentRemain: 100 }];
  trendEnd = ${JSON.stringify(todayStrLocal)};
  dashMode = "day";
  renderLines();
`);
const shrink1Html = run(`$("chart").innerHTML`);
assert(`今天(${label(today)}) 出现`, shrink1Html.includes(label(today)));
assert(`今天-1(${label(dM1)}) 不出现`, !shrink1Html.includes(label(dM1)));
assert(`今天-4(${label(dM4)}) 不出现`, !shrink1Html.includes(label(dM4)));

console.log("T15 手动收缩(日): 数据 3 天(今天-2~今天) + trendEnd=今天 → 窗口 = 今天-2 ~ 今天");
const pts3 = [];
for (let i = 2; i >= 0; i--) {
  const dt = new Date(today.getFullYear(), today.getMonth(), today.getDate() - i);
  pts3.push({ t: dt.toISOString(), v: 5 + i });
}
const dM3 = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 3);
const dM2 = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 2);
run(`
  dashPer = [{ uin: "u1", displayName: "小陈", series: ${JSON.stringify(pts3)}, currentRemain: 100 }];
  trendEnd = ${JSON.stringify(todayStrLocal)};
  dashMode = "day";
  renderLines();
`);
const shrink3Html = run(`$("chart").innerHTML`);
assert(`右边界 = 今天(${label(today)})`, shrink3Html.includes(label(today)));
assert(`左边界 = 今天-2(${label(dM2)})`, shrink3Html.includes(label(dM2)));
assert(`今天-3(${label(dM3)}) 不出现`, !shrink3Html.includes(label(dM3)));

console.log("T16 手动收缩(月): 数据仅当月 + onMonthClick → 只画当月,无空刻度");
run(`
  dashPer = [{ uin: "u1", displayName: "小陈", series: [{ t: ${JSON.stringify(todayIso)}, v: 10 }], currentRemain: 100 }];
  trendEnd = "";
  dashMode = "day";
  onMonthClick();
`);
const monShrinkHtml = run(`$("chart").innerHTML`);
assert(`当月(${curM}月) 出现`, monShrinkHtml.includes(`${curM}月`));
assert(`当月-4(${m0}) 不出现(收缩)`, !monShrinkHtml.includes(m0));
assert(`当月-1 不出现`, !monShrinkHtml.includes(`${curM - 1 <= 0 ? 12 + curM - 1 : curM - 1}月`));

console.log("T17 每月视图清空截止日期 → 保持每月模式并恢复全量(不切每日)");
run(`
  dashPer = [{ uin: "u1", displayName: "小陈", series: ${JSON.stringify(mSer)}, currentRemain: 100 }];
  trendEnd = ${JSON.stringify(todayStrLocal)};
  dashMode = "month";
  onTrendEnd("");
`);
const monthClearHtml = run(`$("chart").innerHTML`);
assert(`保持每月模式(btnMonth active)`, run(`$("btnMonth").className`).includes("active"));
assert(`trendEnd 已清空`, run(`trendEnd`) === "");
assert(`当月(${curM}月) 出现(全量)`, monthClearHtml.includes(`${curM}月`));
assert(`全量最早月(${dMin.getMonth() + 1}月) 出现`, monthClearHtml.includes(`${dMin.getMonth() + 1}月`));

// 恢复 15 天数据 + 干净状态,避免污染后续 T2/T3/T4
run(`
  dashPer = [{ uin: "u1", displayName: "小陈", series: ${JSON.stringify(pts15)}, currentRemain: 100 }];
  trendEnd = "";
  dashMode = "day";
  renderLines();
`);

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
const legendHtml = run(`$("legend").innerHTML`);
assert("合计柱渲染(灰色 data-n=当日合计)", barHtml.includes('data-n="当日合计"'));
assert("图例区最右有「合计」标签", legendHtml.includes(">合计<"), legendHtml.slice(0, 400));
assert("柱子上不再写「合计」二字", !barHtml.includes(">合计<"), barHtml.slice(0, 500));
assert("合计柱值 110 顶部标数字", barHtml.includes('font-weight="700">110<'));
assert("单柱(80/30)不标数字", !barHtml.includes('font-weight="700">80<') && !barHtml.includes('font-weight="700">30<'));
assert("组内标签恰好 1 个(合计 110)", (barHtml.match(/font-weight="700">110<\/text>/g) || []).length === 1);
assert("账号柱带占当日百分比(80→72.7%)", barHtml.includes('data-pct="72.7"'));
assert("账号柱带占当日百分比(30→27.3%)", barHtml.includes('data-pct="27.3"'));
assert("合计柱 data-pct=100", barHtml.includes('data-pct="100"'));

process.exit(report() ? 0 : 1);
