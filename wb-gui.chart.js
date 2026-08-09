// wb-gui.chart.js — 趋势图表层（柱状图渲染/每日窗口/图例交互/模式切换）
// 依赖 wb-gui.state.js（LINE_COLORS/escAttr/acctName/dashMode/dashPer）与 render 层（$ 等工具）。
// 纯渲染，自身不发起网络请求。v1.4.22 从 wb-gui.render.js 拆出（趋势图迭代频繁，独立成模块便于维护）。

const TOTAL_COLOR = "#94a3b8"; // 合计柱/合计图例：中性灰，与账号彩柱区分

// 本地当天 00:00（归一化数据点：X 轴刻度按天对齐，否则数据点 ts 是快照时刻无法与日期刻度匹配）
function dayZero(ts) { const d = new Date(ts); return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }

// 「每日视图」动态窗口：跨度 = 实际有数据的自然日天数，夹在 [3, 5]（下限 3 天、上限 5 天）
// 窗口定位：数据天数 ≤ 跨度 → 从最早数据日开始向右延伸（补未来，折线有伸展空间，如 2 天数据 → 8/3 8/4 8/5）；
//            数据天数 > 跨度 → 取最近 span 天（终点 = 最晚数据日，只看最新 5 天）
// 传入 endDate（"YYYY-MM-DD"，本地自然日）= 手动固定截止日 → 默认窗口 = [所选日-4, 所选日] 共 5 天（终点 = 所选日）；
//            窗口内有数据的天数 < 5 → 收缩到 [窗口内最早数据日, 所选日]（不留空刻度，如仅今天 → 只画今天）
// 「每日」按钮 = 今天-4 ~ 今天；日期框选任意日同理
// 注意：日期键用「本地自然日」(getFullYear/Month/Date)，不能用 toISOString().slice(0,10)（UTC 会错位一天）
function dayWindow(endDate) {
  const keyOf = (ts) => {
    const z = dayZero(ts); // 本地 00:00
    return `${z.getFullYear()}-${String(z.getMonth() + 1).padStart(2, "0")}-${String(z.getDate()).padStart(2, "0")}`;
  };
  const daySet = new Set();
  for (const a of dashPer || []) {
    for (const p of (a.series || [])) daySet.add(keyOf(p.t));
  }
  const sorted = [...daySet].sort();
  if (!sorted.length) return [];
  const parse = (s) => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); }; // 本地 00:00
  let start, span, end = null;
  if (endDate) {
    // 手动截止日：终点 = 所选日，向前取 5 天
    end = parse(String(endDate));
    const lo = new Date(end.getFullYear(), end.getMonth(), end.getDate() - 4);
    const loKey = keyOf(lo), endKey = keyOf(end);
    // 理论窗口 [所选日-4, 所选日] 内有数据的日期；不足 5 天 → 收缩起点到窗口内最早数据日
    const inWin = sorted.filter((k) => k >= loKey && k <= endKey);
    if (inWin.length > 0 && inWin.length < 5) {
      start = parse(inWin[0]); // 收缩:窗口内最早数据日 → 所选日（不留空刻度）
    } else {
      start = lo; // 数据足 5 天或窗口内无数据：固定 5 格
    }
  } else {
    // 默认动态窗口：数据天数在 [3,5] 夹取
    const n = sorted.length;
    span = Math.min(5, Math.max(3, n));
    start = parse(sorted[0]); // 默认从最早数据日开始
    if (n > span) {
      // 数据超过上限：窗口终点 = 最晚数据日，向前取 span 天
      start = new Date(parse(sorted[n - 1]).getTime() - (span - 1) * 86400000);
    }
  }
  const days = [];
  if (endDate) {
    // 手动截止日：按自然日从起点连续生成到所选日（收缩时 span 可能 <5）
    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
      days.push(new Date(d.getFullYear(), d.getMonth(), d.getDate()).toISOString());
    }
  } else {
    for (let i = 0; i < span; i++) days.push(new Date(start.getFullYear(), start.getMonth(), start.getDate() + i).toISOString());
  }
  return days;
}

// 「每月视图」窗口：未指定截止月(trendEnd 空) → 返回全部有数据月份(现状)；
// 点「每月」按钮后 trendEnd=今天 → 以当月为终点，向前取 5 个月（[当月-4, 当月]，跨年由 Date 自动进位）；
// 窗口内有数据的月份 < 5 → 收缩到 [窗口内最早数据月, 当月]（不留空刻度）
function monthWindow() {
  const mSet = new Set();
  for (const a of dashPer || []) {
    for (const p of (a.series || [])) {
      const d = new Date(p.t);
      mSet.add(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
    }
  }
  const sorted = [...mSet].sort();
  if (!sorted.length) return [];
  if (!trendEnd) return sorted; // 无截止月：全部月份
  const key = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  const parseM = (s) => { const [yy, mm] = s.split("-").map(Number); return new Date(yy, mm - 1, 1); };
  const [y, m] = String(trendEnd).slice(0, 7).split("-").map(Number);
  const end = new Date(y, m - 1, 1); // 截止月 1 号(本地)
  const lo = new Date(end.getFullYear(), end.getMonth() - 4, 1);
  const inWin = sorted.filter((k) => k >= key(lo) && k <= key(end));
  const months = [];
  if (inWin.length > 0 && inWin.length < 5) {
    // 收缩:窗口内最早数据月 → 当月（不留空刻度）
    for (let d = parseM(inWin[0]); d <= end; d = new Date(d.getFullYear(), d.getMonth() + 1, 1)) months.push(key(d));
  } else {
    // 数据足 5 个月或窗口内无数据：固定 5 格
    for (let i = 4; i >= 0; i--) months.push(key(new Date(end.getFullYear(), end.getMonth() - i, 1)));
  }
  return months;
}

// 今天(本地自然日)的 "YYYY-MM-DD"（「每日」/「每月」按钮 = 以今天/当月为终点）
function todayStr() {
  const z = dayZero(Date.now());
  return `${z.getFullYear()}-${String(z.getMonth() + 1).padStart(2, "0")}-${String(z.getDate()).padStart(2, "0")}`;
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
function barChart(series, mode, xTicks, soloKey) {
  const all = series.flatMap((s) => s.pts);
  if (!all.length) return '<div class="ph">暂无数据</div>';
  const tickSet = new Set((xTicks || []).map((t) => String(t)));
  for (const p of all) tickSet.add(p.t);
  const times = [...tickSet].sort();
  const w = 640, h = 220, L = 44, R = 14, T = 34, B = 28, iw = w - L - R, ih = h - T - B;
  // 每天分组：该天有数据的账号各一根柱子；末尾紧贴画「当日合计」柱（独立组，不随图例隐藏）
  const dayMap = new Map(times.map((t) => [t, []]));
  for (const s of series) for (const p of s.pts) if (dayMap.has(p.t)) dayMap.get(p.t).push({ key: s.key, name: s.name, v: p.v });
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
    ticks += `<line x1="${L - 6}" y1="${y.toFixed(1)}" x2="${L}" y2="${y.toFixed(1)}" stroke="rgba(255,255,255,.08)"/><text x="${L - 9}" y="${(y + 4).toFixed(1)}" font-size="10" fill="#6b7484" text-anchor="end">${Math.round(v)}</text>`;
  }
  // X 轴日期标签(v1.4.37:统一 middle 锚点——旧逻辑首尾用 start/end,文字中心偏离柱子组中心 16px;x 夹取防越界)
  const step = Math.max(1, Math.ceil(times.length / 6));
  let xl = "";
  times.forEach((t, i) => {
    if (i % step === 0 || i === times.length - 1) {
      const dd = new Date(t);
      const cx = L + (i + 0.5) * (iw / times.length);
      const x = Math.max(L + 16, Math.min(w - R - 16, cx)); // 文字半宽约 16px,夹取保证不压 Y 轴/右缘
      xl += `<text x="${x.toFixed(1)}" y="${h - 8}" font-size="8" fill="#6b7484" text-anchor="middle">${mode === "month" ? (dd.getMonth() + 1) + "月" : (dd.getMonth() + 1) + "月" + dd.getDate() + "日"}</text>`;
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
    const bw = Math.max(2, Math.min(14, (groupW - 2) / Math.max(1, slotCount)));
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
        ? `<text x="${(x + bw / 2).toFixed(1)}" y="${(T + ih - bh - 4).toFixed(1)}" font-size="10" fill="${color}" text-anchor="middle" font-weight="700">${Math.round(d.v)}</text>`
        : "";
      byKey.get(d.key).push(`<rect x="${x.toFixed(1)}" y="${(T + ih - bh).toFixed(1)}" width="${bw.toFixed(1)}" height="${bh.toFixed(1)}" rx="2" fill="${color}" class="cpt" data-key="${d.key}" data-v="${Math.round(d.v)}" data-pct="${pct}" data-t="${t}" data-n="${escAttr(d.name)}"/>${lbl}`);
      // v1.4.36 透明触发区：整列高(绘图区全高)同宽，鼠标移到柱子所在竖列任意高度都能触发浮层(矮柱子不再难 hover)
      byKey.get(d.key).push(`<rect x="${x.toFixed(1)}" y="${T}" width="${bw.toFixed(1)}" height="${ih}" fill="transparent" class="cpt" data-key="${d.key}" data-v="${Math.round(d.v)}" data-pct="${pct}" data-t="${t}" data-n="${escAttr(d.name)}"/>`);
    });
    // 合计柱：紧贴账号柱右侧（无间隔）；顶部只标数值（说明在图例区「合计」标签，柱上不重复写字）
    if (dayTotal > 0) {
      const tx = startX + day.length * bw;
      const tbh = Math.max(1, (dayTotal / maxV) * ih);
      const ty = T + ih - tbh;
      const isMaxTotal = maxItem && maxItem.kind === "total";
      const num = isMaxTotal
        ? `<text x="${(tx + bw / 2).toFixed(1)}" y="${(ty - 4).toFixed(1)}" font-size="10" fill="${TOTAL_COLOR}" text-anchor="middle" font-weight="700">${Math.round(dayTotal)}</text>`
        : "";
      totals += `<rect x="${tx.toFixed(1)}" y="${ty.toFixed(1)}" width="${bw.toFixed(1)}" height="${tbh.toFixed(1)}" rx="2" fill="${TOTAL_COLOR}" class="cpt" data-key="total" data-v="${Math.round(dayTotal)}" data-pct="100" data-t="${t}" data-n="${mode === "month" ? "当月合计" : "当日合计"}"/>${num}`;
      // v1.4.36 合计柱透明触发区（同上）
      totals += `<rect x="${tx.toFixed(1)}" y="${T}" width="${bw.toFixed(1)}" height="${ih}" fill="transparent" class="cpt" data-key="total" data-v="${Math.round(dayTotal)}" data-pct="100" data-t="${t}" data-n="${mode === "month" ? "当月合计" : "当日合计"}"/>`;
    }
  });
  let groups = "";
  for (const [key, rects] of byKey) if (rects.length) groups += `<g id="line-${key}">${rects.join("")}</g>`;
  if (totals) groups += `<g id="line-total">${totals}</g>`;
  const note = `<text x="${w - R}" y="12" font-size="8" fill="#6b7484" text-anchor="end">单位:${mode === "month" ? "积分/月" : "积分/日"}</text>`;
  const minW = window.innerWidth >= 640 ? 430 : 0;
  return `<svg viewBox="0 0 ${w} ${h}" style="width:100%;height:auto;min-width:${minW}px;display:block">${ticks}${groups}${xl}${note}</svg>`;
}

// 趋势渲染入口：读 dashPer 的 series（后端已按自然日算好每日消耗），day 模式归一化到当天 00:00 并按窗口裁剪
function renderLines() {
  const raw = dashPer.filter((a) => (a.series || []).length >= 1);
  if (!raw.length) {
    $("legend").innerHTML = "";
    $("chart").innerHTML = '<div class="ph">暂无足够数据，多刷新几次后出现图表</div>';
    return;
  }
  // day 模式：X 轴动态窗口（3~5 天，或截止日期固定 5 天）；month 模式：有截止月时取最近 5 个月、否则全部月份；all 用实际数据日期。窗口先算好供下方裁剪数据点
  const xTicks = dashMode === "day" ? dayWindow(trendEnd) : (dashMode === "month" ? monthWindow() : null);
  const winMin = xTicks ? xTicks[0] : null, winMax = xTicks ? xTicks[xTicks.length - 1] : null;
  const lines = raw.map((a) => {
    let pts = (a.series || []).slice().sort((a, b) => a.t < b.t ? -1 : 1);
    if (dashMode === "month") {
      const m = new Map();
      for (const p of pts) {
        const d = new Date(p.t), k = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
        m.set(k, (m.get(k) || 0) + p.v);
      }
      pts = [...m.keys()].sort().map((k) => ({ t: k, v: m.get(k) }));
      // 每月视图：裁剪到窗口内（未点「每月」= 全部月份；点了则以当月为终点取最近 5 个月）
      if (winMin && winMax) pts = pts.filter((p) => p.t >= winMin && p.t <= winMax);
    } else if (dashMode === "day") {
      // 每日视图：归一化到本地当天 00:00（与 X 轴刻度对齐），并裁剪到窗口内（窗口外历史点由「全部显示」查看）
      pts = pts
        .map((p) => ({ t: dayZero(p.t).toISOString(), v: p.v }))
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
  $("chart").innerHTML = barChart(lines, dashMode, xTicks, soloKey);
}

// 图例交互：单击=隐藏该账号，再点一次=重新显示（纯切换）
function toggleLine(key, el) {
  const p = document.getElementById("line-" + key);
  if (!p) return;
  p.style.display = p.style.display === "none" ? "" : "none";
  if (el) el.classList.toggle("off", p.style.display === "none");
}

// 模式切换：每日 / 每月 / 全部显示（按钮态 + 重渲染）
function changeMode(mode) {
  dashMode = mode;
  ["btnDay", "btnMonth", "btnAll"].forEach((id) => { const b = $(id); if (b) b.className = "btn btn-g"; });
  const key = mode === "day" ? "btnDay" : mode === "month" ? "btnMonth" : "btnAll";
  const b = $(key); if (b) b.classList.add("active");
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
    chartTip.innerHTML = (el.dataset.n ? `<div class="ct-s">${el.dataset.n}</div>` : "") +
      `<div class="ct-v">${el.dataset.v}</div>` +
      (pct ? `<div class="ct-p">${pct}</div>` : "");
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
