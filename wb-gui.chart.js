// wb-gui.chart.js — 趋势图表层（柱状图渲染/每日窗口/图例交互/模式切换）
// 依赖 wb-gui.state.js（LINE_COLORS/escAttr/acctName/dashMode/dashPer）与 render 层（$ 等工具）。
// 纯渲染，自身不发起网络请求。v1.4.22 从 wb-gui.render.js 拆出（趋势图迭代频繁，独立成模块便于维护）。

const TOTAL_COLOR = "#94a3b8"; // 合计柱/合计图例：中性灰，与账号彩柱区分

// 本地当天 00:00（归一化数据点：X 轴刻度按天对齐，否则数据点 ts 是快照时刻无法与日期刻度匹配）
// v1.12.5:日界口径统一到 +8（见 state.js 的 cnKey/cnDayIso）。
// 返回的是"该自然日 00:00(+8) 对应的真实时刻"，对外仍以 ISO 作为日标识。
function dayZero(ts) { return new Date(cnDayIso(ts)); }

// 「每日 / 每周视图」共用窗口：span=7 → 每周（今天往前 7 天逐日）；span=1 → 每日（只看今天一天）。
// 终点：显式截止日 > 今天(span=1) > 数据最晚日(span>1，避免凌晨无数据时整屏空白)；
// 数据不足 7 天时收缩到窗口内最早有数据日（不留空刻度）。
// 注意：日期键一律走 state.js 的 cnKey（+8 自然日）。不要自己拼 getFullYear/toISOString ——
// 浏览器时区不是 +8 时那条路会错位一天（v1.12.5 已用 test/ui/date-keys.test.mjs 钉死）。
function dayWindow(endDate, spanWanted) {
  const span = Math.max(1, Math.min(31, Math.round(spanWanted) || 7));
  const daySet = new Set();
  for (const a of dashPer || []) {
    for (const p of (a.series || [])) daySet.add(cnKey(p.t));
  }
  const sorted = [...daySet].sort();
  if (!sorted.length) return [];
  const parse = (s) => new Date(String(s) + "T00:00:00+08:00"); // 该日 +8 零点
  let end;
  if (endDate) end = parse(String(endDate));
  else if (span === 1) end = parse(todayStr());
  else end = parse(sorted[sorted.length - 1]);
  let start = new Date(end.getTime() - (span - 1) * 86400000);
  const inWin = sorted.filter((k) => k >= cnKey(start) && k <= cnKey(end));
  if (span > 1 && inWin.length > 0 && inWin.length < span) start = parse(inWin[0]); // 收缩:窗口内最早数据日
  const days = [];
  for (let d = new Date(start); d <= end; d = new Date(d.getTime() + 86400000)) {
    days.push(d.toISOString());
  }
  return days;
}

// 「每月视图」窗口：未指定截止月(trendEnd 空) → 返回全部有数据月份(现状)；
// 点「每月」按钮后 trendEnd=今天 → 以当月为终点，向前取 5 个月（[当月-4, 当月]，跨年由 Date 自动进位）；
// 窗口内有数据的月份 < 5 → 收缩到 [窗口内最早数据月, 当月]（不留空刻度）
// v1.12.5:月份口径同样按 +8，且窗口运算改成"月键字符串"算术（不碰 Date，天然免疫时区）。
function monthWindow() {
  const mSet = new Set();
  for (const a of dashPer || []) {
    for (const p of (a.series || [])) mSet.add(cnMonthKey(p.t));
  }
  const sorted = [...mSet].sort();
  if (!sorted.length) return [];
  if (!trendEnd) return sorted; // 无截止月：全部月份
  const endMk = String(trendEnd).slice(0, 7);
  const addMonths = (mk, n) => {
    const [yy, mm] = mk.split("-").map(Number);
    const t = yy * 12 + (mm - 1) + n;
    return `${Math.floor(t / 12)}-${String(((t % 12) + 12) % 12 + 1).padStart(2, "0")}`;
  };
  const loMk = addMonths(endMk, -4);
  const inWin = sorted.filter((k) => k >= loMk && k <= endMk);
  const months = [];
  if (inWin.length > 0 && inWin.length < 5) {
    // 收缩:窗口内最早数据月 → 当月（不留空刻度）
    for (let mk = inWin[0]; mk <= endMk; mk = addMonths(mk, 1)) months.push(mk);
  } else {
    // 数据足 5 个月或窗口内无数据：固定 5 格
    for (let i = 4; i >= 0; i--) months.push(addMonths(endMk, -i));
  }
  return months;
}

/** "YYYY-MM-DD"(本地自然日) → 本地零点 ISO（与 dayWindow 的刻度口径一致） */
function localDayIso(key) {
  return new Date(String(key) + "T00:00:00+08:00").toISOString();
}

// 今天(+8 自然日)的 "YYYY-MM-DD"（「每日」/「每月」按钮 = 以今天/当月为终点）
function todayStr() {
  return cnKey(Date.now());
}

// 「每周」按钮：近 7 天（今天往前）逐日，截止日重置为今天
function onWeekClick() {
  trendEnd = todayStr();
  const el = $("trendEnd");
  if (el && String(el.value) !== trendEnd) el.value = trendEnd;
  changeMode("week");
}

// 「每日」按钮：截止日期重置为今天（以今天为终点显示最近 5 天），并切到每日模式
function onDayClick() {
  trendEnd = todayStr();
  const el = $("trendEnd");
  if (el && String(el.value) !== trendEnd) el.value = trendEnd;
  changeMode("day");
}

// 「每月」按钮：截止日期重置为今天（每月视图以当月为终点显示最近 5 个月），并切到每月模式
function onMonthClick() {
  trendEnd = todayStr();
  const el = $("trendEnd");
  if (el && String(el.value) !== trendEnd) el.value = trendEnd;
  changeMode("month");
}

// 截止日期选择：日期输入框；值为空 = 恢复当前模式的默认窗口（每日=动态窗口/每月=全部月份）。
// 同时把输入框与 trendEnd 双向同步；仅「选值」时自动切到每日（日期框=每日视图专用语义），
// 清空不切模式（避免在每月视图清空被意外弹回每日视图，不覆盖用户刚选的日期）。
function onTrendEnd(v) {
  trendEnd = v ? String(v) : "";
  const el = $("trendEnd");
  if (el && String(el.value) !== trendEnd) el.value = trendEnd;
  if (v && dashMode !== "day") changeMode("day"); else renderLines();
}

// 柱状图：每个时间点（每日=天/每月=月）该组有数据的账号各一根柱；
// 每组右侧紧贴画「当日/当月合计」灰柱（独立 g#line-total，不随图例显隐），柱子组整体在组内居中，日期标签=组中心；
// 组内最高（单柱或合计柱）顶部标数字；账号柱/合计柱均带 data-pct（占该组总和的百分比，hover 浮层用）。
// v1.4.41 soloKey:点击柱子独显该账号(每天只画它)或 total(只画合计);null=全部。点击空白恢复(见 initChartSolo)。
// v1.12.4:图表此刻是否在放大层里。放大层不是把 SVG 缩放到满屏就完事 ——
// 字号是写死的 px(v1.10.0 起按容器宽度分 big/非 big 两档),放大后必须按更高一档重画,
// 否则依然是 11/13px 的小字,只是被摊大。
function inZoomChart() {
  const c = $("chart");
  return !!(c && c.closest && c.closest("#zoomBody"));
}
function barChart(series, mode, xTicks, soloKey, boxW, mark) {
  const all = series.flatMap((s) => s.pts);
  if (!all.length) return '<div class="ph">暂无数据</div>';
  const tickSet = new Set((xTicks || []).map((t) => String(t)));
  for (const p of all) tickSet.add(p.t);
  const times = [...tickSet].sort();
  // 画布宽随容器走(340~1200):窄屏/侧栏不被压缩,放大层/全宽时放大画布与字号
  const w = Math.max(340, Math.min(1200, Math.round(boxW) || 640));
  // v1.12.4:放大层再提一档 —— 字号 ×1.4,左侧刻度留白同步加宽(刻度是右对齐在 L-9,
  // 字号变大后不加大 L 会被切掉),上下留白略加给"单位"和日期行。
  // big 必须带上 zf:1000~1300 视口下趋势面板是全宽的(实测 1078~1108),
  // 而放大层只有 80vw(≈895),只看宽度反而会掉回非 big 档 —— 那就"放大了字没变大"。
  const zf = inZoomChart() ? 1.4 : 1;
  const big = w >= 900 || zf > 1;
  const h = Math.round((big ? 300 : 220) * (zf > 1 ? 1.15 : 1));
  const fs = Math.round((big ? 11 : 8) * zf);
  const fv = Math.round((big ? 13 : 10) * zf);
  const L = Math.round(44 * zf), R = 14;
  const T = Math.round(34 * (zf > 1 ? 1.2 : 1)), B = Math.round(28 * (zf > 1 ? 1.2 : 1));
  const iw = w - L - R, ih = h - T - B;
  // 组数很少时(今日=1 组)放宽柱宽上限,否则 13 根柱挤在画布中央一小撮
  const BW_MAX = times.length <= 2 ? 56 : 14;
  // 每天分组：该天有数据的账号各一根柱子；末尾紧贴画「当日合计」柱（独立组，不随图例隐藏）
  const dayMap = new Map(times.map((t) => [t, []]));
  for (const s of series) for (const p of s.pts) if (dayMap.has(p.t)) dayMap.get(p.t).push({ key: s.key, name: s.name, v: p.v, b: p.b });
  // 口径切换日集合（v1.9.2）：任一账号该日带 b 标记 → 该日整组（含合计柱）画警示样式。
  // 这一天的消耗含跨 used 语义断点（守卫丢弃了交界差分），数值天然不完整。
  const bDays = new Set(all.filter((p) => p.b).map((p) => p.t));
  // Y 轴最大值须覆盖「单柱峰值」与「组合计」，否则合计柱会超出顶部
  const dayTotals = new Map([...dayMap].map(([t, d]) => [t, d.reduce((s, x) => s + x.v, 0)]));
  const maxV = Math.max(...all.map((p) => p.v), ...dayTotals.values(), 1);
  const colorOf = (key) => LINE_COLORS[Math.max(0, series.findIndex((s) => s.key === key)) % LINE_COLORS.length];
  const byKey = new Map(series.map((s) => [s.key, []]));
  const groupW = iw / times.length;
  let totals = ""; // 合计柱（当日/当月总计），独立渲染不参与图例显隐
  // Y 轴刻度（0 ~ maxV）
  let ticks = "";
  for (let k = 0; k <= 3; k++) {
    const v = (maxV * k) / 3, y = T + ih - (v / maxV) * ih;
    ticks += `<line x1="${L - 6}" y1="${y.toFixed(1)}" x2="${L}" y2="${y.toFixed(1)}" stroke="rgba(255,255,255,.08)"/><text x="${L - 9}" y="${(y + 4).toFixed(1)}" font-size="${fs}" fill="#6b7484" text-anchor="end">${Math.round(v)}</text>`;
  }
  // X 轴日期标签(v1.4.37:统一 middle 锚点;x 夹取防越界)
  // v1.10.4:每周(7 格)标签用 M/D 全标;当天刻度必标且加粗(文字为具体日期)
  // 每周 7 格、每日 1 格 —— 都放得下,不抽稀;每月/全部沿用最多 7 个刻度
  const maxLabels = mode === "week" ? 7 : mode === "day" ? 1 : 7;
  const step = Math.max(1, Math.ceil(times.length / maxLabels));
  // v1.10.4:今天不再写「今天」二字,一律显示具体日期(当天仍加粗以便一眼认出)
  const labelOf = (t) => {
    // v1.12.5:月份模式 t 本身就是 "YYYY-MM" 月键；日/周模式按 +8 墙钟读日月
    if (mode === "month") return Number(String(t).slice(5, 7)) + "月";
    const z = cnWall(t);
    if (mode === "week") return (z.getUTCMonth() + 1) + "/" + z.getUTCDate();
    return (z.getUTCMonth() + 1) + "月" + z.getUTCDate() + "日";
  };
  let xl = "";
  times.forEach((t, i) => {
    const isMark = !!(mark && t === mark);
    if (i % step === 0 || i === times.length - 1 || isMark) {
      const cx = L + (i + 0.5) * (iw / times.length);
      const x = Math.max(L + 16, Math.min(w - R - 16, cx)); // 文字半宽约 16px,夹取保证不压 Y 轴/右缘
      const strong = isMark ? ' font-weight="700" fill="#eef0f4"' : "";
      xl += `<text x="${x.toFixed(1)}" y="${h - 8}" font-size="${fs}" fill="#6b7484" text-anchor="middle"${strong}>${labelOf(t)}</text>`;
    }
  });
  // 绘制：账号柱 + 合计柱
  times.forEach((t, i) => {
    const dayRaw = dayMap.get(t) || [];
    // solo 模式:点账号 → 每天只画它;点合计 → 每天只画合计
    const day = soloKey === "total" ? [] : (soloKey ? dayRaw.filter((d) => d.key === soloKey) : dayRaw);
    const dayTotal = soloKey === "total" ? (dayTotals.get(t) || 0) : (soloKey ? 0 : (dayTotals.get(t) || 0));
    // 每根柱(含合计)一个槽位,各分 (groupW-2) 等宽; bw 上限 14 避免撑爆相邻组
    const slotCount = day.length + (dayTotal > 0 ? 1 : 0);
    const bw = Math.max(2, Math.min(BW_MAX, (groupW - 2) / Math.max(1, slotCount)));
    // 柱子组总宽 = 账号柱 + 合计柱(紧贴无间隔)；整体在组内居中 → 日期标签(组中心)与柱子组中心对齐
    const totalW = day.length * bw + (dayTotal > 0 ? bw : 0);
    const startX = L + i * groupW + Math.max(0, (groupW - totalW) / 2);
    // 组内最高（单柱或合计柱）只标一个数字
    let maxItem = null, groupMax = -1;
    if (dayTotal > groupMax) { groupMax = dayTotal; maxItem = { kind: "total" }; }
    for (const d of day) if (d.v > groupMax) { groupMax = d.v; maxItem = { kind: "bar", d }; }
    day.forEach((d, j) => {
      const x = startX + j * bw;
      const bh = Math.max(1, (d.v / maxV) * ih);
      const isMax = maxItem && maxItem.kind === "bar" && d === maxItem.d;
      const color = colorOf(d.key);
      const pct = dayTotal > 0 ? ((d.v / dayTotal) * 100).toFixed(1) : "0";
      const lbl = isMax
        ? `<text x="${(x + bw / 2).toFixed(1)}" y="${(T + ih - bh - 4).toFixed(1)}" font-size="${fv}" fill="${color}" text-anchor="middle" font-weight="700">${Math.round(d.v)}</text>`
        : "";
      // 口径切换日柱：半透明 + 琥珀虚线描边（与正常柱一眼区分），data-b 带给浮层
      const bAttr = d.b ? ' data-b="1" opacity="0.55" stroke="#d9a441" stroke-dasharray="2 1.5" stroke-width="1"' : "";
      byKey.get(d.key).push(`<rect x="${x.toFixed(1)}" y="${(T + ih - bh).toFixed(1)}" width="${bw.toFixed(1)}" height="${bh.toFixed(1)}" rx="2" fill="${color}"${bAttr} class="cpt" data-key="${d.key}" data-v="${Math.round(d.v)}" data-pct="${pct}" data-t="${t}" data-n="${escAttr(d.name)}"/>${lbl}`);
      // v1.4.36 透明触发区：整列高(绘图区全高)同宽，鼠标移到柱子所在竖列任意高度都能触发浮层(矮柱子不再难 hover)
      byKey.get(d.key).push(`<rect x="${x.toFixed(1)}" y="${T}" width="${bw.toFixed(1)}" height="${ih}" fill="transparent"${d.b ? ' data-b="1"' : ""} class="cpt" data-key="${d.key}" data-v="${Math.round(d.v)}" data-pct="${pct}" data-t="${t}" data-n="${escAttr(d.name)}"/>`);
    });
    // 合计柱：紧贴账号柱右侧（无间隔）；顶部只标数值（说明在图例区「合计」标签，柱上不重复写字）
    if (dayTotal > 0) {
      const tx = startX + day.length * bw;
      const tbh = Math.max(1, (dayTotal / maxV) * ih);
      const ty = T + ih - tbh;
      const isMaxTotal = maxItem && maxItem.kind === "total";
      const num = isMaxTotal
        ? `<text x="${(tx + bw / 2).toFixed(1)}" y="${(ty - 4).toFixed(1)}" font-size="${fv}" fill="${TOTAL_COLOR}" text-anchor="middle" font-weight="700">${Math.round(dayTotal)}</text>`
        : "";
      // 口径切换日的合计柱同样不完整 → 与账号柱同款警示样式
      const tbAttr = bDays.has(t) ? ' data-b="1" opacity="0.55" stroke="#d9a441" stroke-dasharray="2 1.5" stroke-width="1"' : "";
      totals += `<rect x="${tx.toFixed(1)}" y="${ty.toFixed(1)}" width="${bw.toFixed(1)}" height="${tbh.toFixed(1)}" rx="2" fill="${TOTAL_COLOR}"${tbAttr} class="cpt" data-key="total" data-v="${Math.round(dayTotal)}" data-pct="100" data-t="${t}" data-n="${mode === "month" ? "当月合计" : "当日合计"}"/>${num}`;
      // v1.4.36 合计柱透明触发区（同上）
      totals += `<rect x="${tx.toFixed(1)}" y="${T}" width="${bw.toFixed(1)}" height="${ih}" fill="transparent"${bDays.has(t) ? ' data-b="1"' : ""} class="cpt" data-key="total" data-v="${Math.round(dayTotal)}" data-pct="100" data-t="${t}" data-n="${mode === "month" ? "当月合计" : "当日合计"}"/>`;
    }
  });
  let groups = "";
  for (const [key, rects] of byKey) if (rects.length) groups += `<g id="line-${key}">${rects.join("")}</g>`;
  if (totals) groups += `<g id="line-total">${totals}</g>`;
  // 口径切换日组顶 ⚠ 角标（v1.9.2）：只标组位置不标数值，详细解释在浮层与左上图注
  let warn = "";
  if (bDays.size) {
    times.forEach((t, i) => {
      if (!bDays.has(t)) return;
      const cx = L + (i + 0.5) * (iw / times.length);
      warn += `<text x="${cx.toFixed(1)}" y="12" font-size="${fs + 1}" fill="#d9a441" text-anchor="middle">⚠</text>`;
    });
  }
  const note = `<text x="${w - R}" y="12" font-size="${fs}" fill="#6b7484" text-anchor="end">单位:${mode === "month" ? "积分/月" : "积分/日"}</text>`;
  const bNote = bDays.size ? `<text x="${L}" y="12" font-size="${fs}" fill="#d9a441" text-anchor="start">⚠=口径切换日,当日消耗不完整</text>` : "";
  // viewBox 与容器同宽 → 不再需要 min-width 横滚(v1.10.0 图表进右栏)
  return `<svg viewBox="0 0 ${w} ${h}" style="width:100%;height:auto;display:block">${ticks}${groups}${xl}${warn}${bNote}${note}</svg>`;
}

// 模式按钮态从 dashMode 单点同步(唯一真源):改默认值只改 state.js 一处,
// 不会出现"默认每周但高亮停在今日"的错位(v1.10.11 之前 active 是写死在 HTML 里的)
function syncModeBtns() {
  const map = { day: "btnDay", week: "btnWeek", month: "btnMonth", all: "btnAll" };
  for (const [k, id] of Object.entries(map)) {
    const b = $(id);
    if (b) b.classList.toggle("active", dashMode === k);
  }
}

// 趋势渲染入口：读 dashPer 的 series（后端已按自然日算好每日消耗），day 模式归一化到当天 00:00 并按窗口裁剪
function renderLines() {
  syncModeBtns();
  const raw = dashPer.filter((a) => (a.series || []).length >= 1);
  if (!raw.length) {
    $("legend").innerHTML = "";
    $("chart").innerHTML = '<div class="ph">暂无足够数据，多刷新几次后出现图表</div>';
    return;
  }
  // week 模式：今天往前 7 天逐日；day 模式：只看今天 1 格；month：近 5 个月；all：全部数据日
  const xTicks = dashMode === "week" ? dayWindow(trendEnd, 7)
    : dashMode === "day" ? dayWindow(trendEnd, 1)
    : (dashMode === "month" ? monthWindow() : null);
  const winMin = xTicks ? xTicks[0] : null, winMax = xTicks ? xTicks[xTicks.length - 1] : null;
  const lines = raw.map((a) => {
    let pts = (a.series || []).slice().sort((a, b) => a.t < b.t ? -1 : 1);
    if (dashMode === "month") {
      const m = new Map();
      for (const p of pts) {
        const k = cnMonthKey(p.t); // v1.12.5:按 +8 归月
        m.set(k, (m.get(k) || 0) + p.v);
      }
      pts = [...m.keys()].sort().map((k) => ({ t: k, v: m.get(k) }));
      // 每月视图：裁剪到窗口内（未点「每月」= 全部月份；点了则以当月为终点取最近 5 个月）
      if (winMin && winMax) pts = pts.filter((p) => p.t >= winMin && p.t <= winMax);
    } else if (dashMode === "week" || dashMode === "day") {
      // 每日/每周视图：归一化到本地当天 00:00（与 X 轴刻度对齐），并裁剪到窗口内（窗口外历史点由「全部」查看）
      // b=口径切换日标记随点透传（v1.9.2）
      pts = pts
        .map((p) => ({ t: dayZero(p.t).toISOString(), v: p.v, b: p.b }))
        .filter((p) => !winMin || (p.t >= winMin && p.t <= winMax));
    }
    return pts.length ? { key: a.uin, name: acctName(a), pts } : null;
  }).filter(Boolean);
  if (!lines.length) {
    $("legend").innerHTML = "";
    $("chart").innerHTML = '<div class="ph">暂无足够数据，多刷新几次后出现图表</div>';
    return;
  }
  // 图例 = 账号标签 + 最右侧「合计」标签（灰色，点击隐藏/显示合计柱，交互与账号一致）
  // 账号名可自定义,插入 innerHTML 前必须转义(v1.4.45)
  $("legend").innerHTML = raw
    .map((a, i) => `<div class="lg" data-key="${a.uin}" onclick="toggleLine('${a.uin}', this)"><i style="background:${LINE_COLORS[i % LINE_COLORS.length]}"></i>${escAttr(acctName(a))}</div>`)
    .join("") + `<div class="lg" data-key="total" onclick="toggleLine('total', this)"><i style="background:${TOTAL_COLOR}"></i>合计</div>`;
  // v1.10.0:按容器实际宽度出图(面板刚从折叠态展开时 clientWidth 可能为 0,回退 640)
  const cw = ($("chart") && $("chart").clientWidth) || 640;
  // 当前周期标记：窗口里含「今天」才标，加粗显示（"每日"只有一格，就是今天）
  const mark = (dashMode === "week" || dashMode === "day")
    ? (xTicks || []).find((t) => t === localDayIso(todayStr())) || null
    : null;
  $("chart").innerHTML = barChart(lines, dashMode, xTicks, soloKey, cw, mark);
}

// 图例交互：单击=隐藏该账号，再点一次=重新显示（纯切换）
function toggleLine(key, el) {
  const p = document.getElementById("line-" + key);
  if (!p) return;
  p.style.display = p.style.display === "none" ? "" : "none";
  if (el) el.classList.toggle("off", p.style.display === "none");
}

// 模式切换：今日 / 每周 / 每月 / 全部（按钮态由 syncModeBtns 从 dashMode 推出）
function changeMode(mode) {
  dashMode = mode;
  syncModeBtns();
  renderLines();
}

// ---- 图表悬浮提示(v1.4.38 从 actions.js 聚合归位;事件委托,由 actions 启动段调用) ----
// hover 柱子/透明触发区(整列)显示三段式浮层:名字最上 → 数量 → 占当前百分比。
// data-pct 由 barChart 渲染时算好(合计柱=100);委托挂在 document,柱子动态重建无需重绑。
function initChartTip() {
  const chartTip = $("chartTip");
  if (!chartTip) return;
  const chartBox = () => ($("chart").closest(".pbody.line") || document.body).getBoundingClientRect();
  const placeTip = (e) => {
    const box = chartBox(), w = chartTip.offsetWidth, h = chartTip.offsetHeight;
    let lx = e.clientX - box.left + 14, ly = e.clientY - box.top - h - 8;
    if (lx + w > box.width - 4) lx = e.clientX - box.left - w - 14;
    if (ly < 4) ly = e.clientY - box.top + 18;
    chartTip.style.left = lx + "px";
    chartTip.style.top = ly + "px";
  };
  document.addEventListener("mouseover", (e) => {
    const el = e.target.closest && e.target.closest(".cpt");
    if (!el) return;
    chartTip.hidden = false;
    const pct = el.dataset.pct !== undefined ? `占当前 ${el.dataset.pct}%` : "";
    const bTip = el.dataset.b === "1" ? `<div class="ct-p">口径切换日·当日消耗不完整</div>` : "";
    chartTip.innerHTML = (el.dataset.n ? `<div class="ct-s">${el.dataset.n}</div>` : "") +
      `<div class="ct-v">${el.dataset.v}</div>` +
      (pct ? `<div class="ct-p">${pct}</div>` : "") + bTip;
    placeTip(e);
  });
  document.addEventListener("mousemove", (e) => { if (!chartTip.hidden) placeTip(e); });
  document.addEventListener("mouseout", (e) => { if (e.target.closest && e.target.closest(".cpt")) chartTip.hidden = true; });
}

// ---- 点击柱子独显 / 点击空白恢复(v1.4.41) ----
// 点击某账号的柱子 → 每天只显示该账号(独显该柱数据);点击合计柱 → 每天只显示合计;
// 点击图表空白处 → 恢复全部柱子一起显示。soloKey 由 renderLines 传给 barChart。
let soloKey = null;
function initChartSolo() {
  document.addEventListener("click", (e) => {
    const el = e.target.closest && e.target.closest(".cpt");
    if (el && el.dataset.key) {
      const k = el.dataset.key;
      soloKey = soloKey === k ? null : k; // 再点同一柱子=取消独显(等价点空白)
      renderLines();
      return;
    }
    // 点击图表区域内非柱子(空白)→ 恢复全部
    const chart = $("chart");
    if (soloKey && chart && chart.contains(e.target)) {
      soloKey = null;
      renderLines();
    }
  });
}
