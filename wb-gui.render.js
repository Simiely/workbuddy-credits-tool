// wb-gui.render.js — 渲染层（hero/卡片/仪表盘表格/到期柱图）（wb-gui 拆分第 3 部分）
// 依赖 wb-gui.state.js（状态/常量/helper）与 wb-gui.core.js（api/toast 等）。
// 本层只负责把数据画到 DOM；所有数据来自单一 model：账号对象 r 上的 r.derived（由 doRefresh 合并）
// 与 dashPer（表格视图）。render*/renderDash 都是纯函数，自身不发起任何网络请求。
// 趋势柱状图/窗口/图例/模式切换已拆分到 wb-gui.chart.js（加载顺序 render.js → chart.js → ops.js）。

// 数据指纹:刷新时比较,未变则跳过卡片/hero 重绘(自动刷新不再整页闪屏/抖动)
// 派生字段(expiring3d/todayUsed/alerts)也纳入指纹 → 仪表盘派生就绪后卡片会自动重绘
// 整数版金额格式(仅账号小卡片用,去掉小数;hero 汇总卡仍用带 2 位小数的 fmt)
const fmt0 = (n) => (n === "-" || n == null ? "-" : Math.round(Number(n) || 0).toLocaleString());

// v1.8.3 回收标记（取代 v1.7.2 的世代标记 ↻MM-DD）：
// 服务端回收/轮换积分包时，包里**已用掉的部分**会从"当前包的已用"里消失 —— 旧模型把这
// 当成"账号被重建"，于是重置累计、数字跳水（详见 src/compute/ledger.js）。现在它只是账本里
// 一笔可见的 recycled：累计消耗不受影响，标记只在名字后提示"这个号的包被收回过"，
// 悬停看具体量。无回收时输出空串，零视觉影响。
// v1.9.4（2026-10-25 用户要求）：**账号总览**（手机卡片 + 桌面表格）不再显示这个标记 ——
// 表格里每行都挂一枚 ↺N 太吵；只保留在顶部账号卡片网格上（那里一个号一张卡，提示有意义）。
// 取值兼容两种形状：仪表盘行（派生字段平铺）与账号对象（派生挂在 .derived 上）。
const ledgerBadge = (a) => {
  const d = (a && a.ledger) || (a && a.derived && a.derived.ledger) || null;
  const recy = d ? Number(d.recycled) || 0 : 0;
  return recy > 0
    ? ` <span class="epb" title="服务端回收过积分包（已用计数消失 ${recy}）；累计消耗不受影响">↺${Math.round(recy)}</span>`
    : "";
};

function fpS() {
  const rs = (S && S.results) || [];
  return rs.map((r) => {
    const s = r.summary, d = r.derived || {};
    return (r.account.id || "") + "|" + (s ? [s.giftRemain, s.giftUsed, s.giftCount].join(",") : "f") + "|"
      + "|d" + (d.todayAdded ?? 0) + "|" + (d.yesterdayRemain ?? 0) + "|" + (d.todayUsed || 0) + "|" + ((d.dailyUsed || []).length);
  }).join(";");
}

function render() {
  // S 未变 → hero/卡片不重绘(重绘会闪屏、重绑拖拽;节点保留则事件与滚动位置都在)
  const sfp = fpS();
  if (sfp !== lastSfp) {
    renderHero();
    renderCards();
    lastSfp = sfp;
  }
  renderDash(); // 表格/折线(读 dashPer,纯渲染)
}

// v1.10.0 KPI 数字条（取代 4 张 hero 大卡）:enriched KPI tile 口径 —— 每格 = 主数值 + 对比基线
// （较昨日 delta）/ 状态副行，顶层 5 格在 Miller 7±2 内。第 5 格「需关注」= 例外计数,点击即筛
// 表格到例外视图（Overview first → zoom & filter → details on demand）。
// 「需关注」口径:查询失败 ∪ 今日未签到 —— **只收今天要行动的事**。
//   实测教训(2026-10-28,12 账号真实数据):最初把「近7天有临期」也算进去,命中 10/12 ——
//   签到包 30 天滚动过期、消耗跟不上,临期是这些账号的**常态**,把它当例外=天天狼来了
//   (Few: 告警失去区分度就没人看了)。临期降级为视觉提示:行状态点只在近1天(今明作废)亮琥珀,
//   完整到期压力看右栏周桶图与列头排序。signedInToday===false 才算未签:null(今日无快照)不算,
//   避免采样前全员误报。
function warnOf(a) {
  return a.ok === false || a.signedInToday === false;
}
function statusOf(a) {
  if (a.ok === false) return { c: "bad", t: "查询失败" + (a.err ? ":" + a.err : "") };
  if (a.signedInToday === false) return { c: "bad", t: "今日未签到" };
  if ((a.expiring1d || 0) > 0) return { c: "warn", t: "今明作废 " + fmt0(a.expiring1d) + " 分" };
  return { c: "ok", t: "正常" };
}

function renderHero() {
  const rs = (S && S.results) || [];
  const okN = rs.filter((r) => r.summary).length;
  const failN = rs.length - okN;
  const total = rs.reduce((s, r) => s + (r.summary ? totalOf(r.summary) : 0), 0);
  const used = rs.reduce((s, r) => s + (((r.derived || {}).consumed) || 0), 0); // 累计已用=历史每日消耗之和(derived.consumed)
  const tAddAll = rs.reduce((s, r) => { const v = (r.derived || {}).todayAdded; return s + (v == null ? 0 : v); }, 0);
  const tAddHas = rs.some((r) => (r.derived || {}).todayAdded != null);
  const yestRemainAll = rs.reduce((s, r) => { const v = (r.derived || {}).yesterdayRemain; return s + (v == null ? 0 : v); }, 0);
  const yRemainHas = rs.some((r) => (r.derived || {}).yesterdayRemain != null);
  const totalUsed = rs.reduce((s, r) => s + (((r.derived || {}).todayUsed) || 0), 0);
  // 昨日已用(自然日):从 dailyUsed 取昨天的消耗作对比基准;昨天无记录则只显示数值不显示箭头
  // v1.12.5:必须用 +8 日键去匹配后端 dailyUsed[].day，否则非 +8 时区的浏览器拿"本地昨天"去比"北京昨天"，永远错配
  const yestK = cnKey(Date.now() - 86400000);
  let yestUsed = 0, yestHas = false;
  for (const r of rs) {
    const y = (((r.derived || {}).dailyUsed) || []).find((x) => x.day === yestK);
    if (y) { yestUsed += y.used || 0; yestHas = true; }
  }
  let cls = "ok", sub = "✅ 一切正常";
  if (!rs.length) { cls = ""; sub = "账号池为空,先运行 trae-credits.bat scan 扫描本机登录态"; }
  else if (failN > 0) { cls = "warn"; sub = `${failN} 个账号查询失败`; }
  else sub = `✅ 一切正常 · ${okN}/${rs.length} 账号有效`;
  // 今日已用环比昨日(自然日):↑=今天比昨天用得多,↓=用得少
  let trendHtml = totalUsed > 0 ? fmt0(totalUsed) : "0";
  if (yestHas) {
    const delta = totalUsed - yestUsed;
    const arrow = delta > 0 ? "↑" : "↓";
    const c = delta > 0 ? "var(--bad)" : "var(--ok)";
    trendHtml = `${fmt0(totalUsed)} <span style="font-size:12px;color:${c}" title="较昨日${delta >= 0 ? "多" : "少"}用 ${fmt0(Math.abs(delta))}">${arrow}${fmt0(Math.abs(delta))}</span>`;
  }
  // v1.10.13:整块回退到 v1.9.6 —— 用户"上面 4 个面板，是退回 v1.9.6 的版本，那个是对的"。
  // 结构:图标挂右上角(.h-ico) → 大数字 → 标签在下;首卡带状态副行,第二卡"昨日结余|今日到账"双列。
  $("hero").innerHTML = `
    <div class="hcard total ${cls}"><span class="h-ico">🏦</span><div class="n" id="heroTotal">${rs.length ? fmt0(total) : "—"}</div><div class="l"><span>总剩余积分</span><span class="st">${sub}</span></div></div>
    <div class="hcard ${tAddHas ? "ok" : ""}"><span class="h-ico">📥</span><div class="two"><div><div class="n" id="heroYestRemain">${yRemainHas ? fmt0(yestRemainAll) : "—"}</div><div class="l">昨日结余</div></div><div><div class="n" id="heroTodayAdd" style="color:var(--ok)">${tAddHas ? "+" + fmt0(tAddAll) : "—"}</div><div class="l">今日到账</div></div></div></div>
    <div class="hcard"><span class="h-ico">📉</span><div class="n" id="heroToday">${trendHtml}</div><div class="l">今日已用</div></div>
    <div class="hcard"><span class="h-ico">🔥</span><div class="n">${fmt0(used)}</div><div class="l">累计已用</div></div>`;
}

// ---------- 过期统计（已收口到后端 derive.js 单派生源） ----------
// 前端不再从 r.data.Accounts 现算到期，全部消费 dashPer 的 expiring1d/expiring3d/giftBuckets/expiryTier。

// 各账号今日消耗/告警直接读 r.derived（由 dashboard/all 合并），不再维护独立 map。

function renderCards() {
  const rs = (S && S.results) || [];
  if (!rs.length) {
    $("grid").innerHTML = '<div class="empty"><div class="big">📭</div>账号池为空<br>先运行 <b>trae-credits.bat scan</b> 扫描本机 TRAE 登录态建立账号池,或导入 trae-accounts.json 备份</div>';
    $("foot").textContent = "v__APP_VERSION__ · 数据来自 TRAE 官方接口(api.trae.cn) · 暂无账号数据(先运行 trae-credits.bat scan 或从 WebDAV 下载)";
    return;
  }
  $("grid").innerHTML = rs.map((r, i) => {
    const a = r.account, s = r.summary;
    const nm = escAttr(acctName(a)) + ledgerBadge(a); // 显示名可自定义,必须转义后进 innerHTML(v1.4.50)
    // v1.10.18:改名/删除移到卡片底部那一行的右端(左端是「已签到」),今日消耗独占一行
    const acts = `<span class="acts"><button class="btn btn-d" onclick="event.stopPropagation();openRename('${a.id}')">改名</button>
      <button class="btn btn-d" onclick="event.stopPropagation();openDel('${a.id}')">删除</button></span>`;
    if (!s) {
      return `<div class="acct${a.appKey === "workbuddy" ? " wb" : ""}" data-id="${a.id}" draggable="true" onclick="openDetail('${a.id}')"><div class="acct-top">
        <div><div class="acct-name"><span class="nm">${nm}</span></div></div>
        <span class="remain" style="color:var(--bad);border-color:currentColor;background:transparent">❌ 查询失败</span></div>
        <div class="acct-rows"><div class="arow act-row"><div class="l">${escAttr(r.error || "查询失败")}</div></div>
        <div class="acct-foot">${acts}</div></div></div>`;
    }
    // v1.10.7 卡片瘦身:去掉中间的「积分包/进度条」行(剩余=右上的总剩余,总量与包明细在明细弹窗),
    // 让 380px 侧栏能一行放两张卡
    const dv = r.derived || {};
    // 签到标记：后端 derive 读今日快照 signedIn（checkin 接口固化，当天恒定）
    const signed = dv.signedInToday
      ? `<span class="signed" title="今日已签到">✅ 已签到</span>`
      : `<span class="signed no" title="今日未签到">⏰ 未签到</span>`;
    // v1.9.6（用户要求）：卡片不再显示「📥 到账 +N」—— 徽标把右侧「总剩余积分」挤到被
    // 卡片边缘切割，且签到奖励额官方随时调（200→150→100），数字本身没有阅读价值；
    // 汇总层面的到账仍看顶部 hero 卡。derive.todayAdded 照常计算，只摘展示。
    return `<div class="acct${a.appKey === "workbuddy" ? " wb" : ""}" data-id="${a.id}" data-uin="${a.uin}" draggable="true" onclick="openDetail('${a.id}')" title="${escAttr(appLabel(a))} · 点击查看明细"><div class="acct-top">
      <div><div class="acct-name"><span class="nm">${nm}</span></div><div class="acct-chip"><span class="app-chip" title="软件来源">${escAttr(appLabel(a))}</span></div></div>
      <div class="remain-side"><div class="remain"><span class="tt">💎 总剩余积分</span><span class="tn">${fmt0(totalOf(s))}</span></div></div></div>
      <div class="acct-rows">
        <div class="arow act-row"><div class="l t-brand"><div class="acct-today">今日消耗 ${fmt0(dv.todayUsed || 0)}</div></div></div>
        <div class="acct-foot">${signed}${acts}</div>
      </div></div>`;
  }).join("");
  initDrag();
  $("foot").textContent = "v__APP_VERSION__ · 数据来自 TRAE 官方接口(api.trae.cn) · 页面自动刷新 " + autoMin + " 分钟 · 查询失败可重新运行 trae-credits.bat scan 更新登录态 · 卡片可拖动排序";
}

// ---- 卡片拖拽排序(顺序随账号池持久化,经 /api/reorder 保存) ----
function initDrag() {
  const grid = $("grid");
  // 手机/触屏:HTML5 drag 不可用,禁用拖拽并提示用排序按钮
  const isTouch = window.matchMedia && window.matchMedia("(hover: none)").matches;
  if (isTouch) {
    grid.querySelectorAll(".acct").forEach((card) => { card.draggable = false; });
    return;
  }
  grid.querySelectorAll(".acct").forEach((card) => {
    card.addEventListener("dragstart", (e) => {
      dragId = card.dataset.id;
      suppressClick = true;
      setTimeout(() => { suppressClick = false; }, 0);
      card.classList.add("dragging");
      e.dataTransfer.effectAllowed = "move";
      try { e.dataTransfer.setData("text/plain", dragId); } catch {}
    });
    card.addEventListener("dragend", () => {
      dragId = null;
      card.classList.remove("dragging");
      grid.querySelectorAll(".acct").forEach((c) => c.classList.remove("drag-over"));
    });
    card.addEventListener("dragover", (e) => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; });
    card.addEventListener("dragenter", (e) => { e.preventDefault(); if (dragId && card.dataset.id !== dragId) card.classList.add("drag-over"); });
    card.addEventListener("dragleave", () => card.classList.remove("drag-over"));
    card.addEventListener("drop", (e) => {
      e.preventDefault();
      card.classList.remove("drag-over");
      if (!dragId || card.dataset.id === dragId) return;
      moveCard(dragId, card.dataset.id);
    });
  });
}

// renderDash 是纯渲染函数：只读 dashPer（S.results 的投影，已含凭证状态与派生指标），不发起网络请求。
// 数据获取与 derived 合并统一在 actions.js 的 doRefresh/mergeDerived 完成，避免多源竞态。
function renderDash() {
  renderDashTools();
  renderDashTable();
  renderLines();
  if (dashPer.length) {
    const lastTs = dashPer.reduce((m, a) => {
      const pts = a.series || [];
      return pts.length ? Math.max(m, ...pts.map((p) => new Date(p.t).getTime())) : m;
    }, 0);
    if (lastTs) $("dashMeta").textContent = dashPer.length + " 个账号 · " + new Date(lastTs).toLocaleString("zh-CN").slice(5);
  }
}
function renderDashTable() {
  if (!dashPer.length) {
    $("dashCards").innerHTML = '<div class="ph ph-md">暂无账号</div>';
    $("dashTbody").innerHTML = '<tr><td colspan="9" class="ph">暂无账号</td></tr>';
    $("dashThead").innerHTML = "";
    $("dashTfoot").innerHTML = "";
    $("dashMeta").textContent = "";
    return;
  }
  // 单元格工具(卡片版)
  const cell = (label, val, color, bg, big) => `<div class="dcell ${bg}" ${color ? `style="--dc:var(--${color})"` : ""}>${big ? `<div class="dc-l">${label}</div><div class="dc-v big">${val}</div>` : `<div class="dc-l">${label}</div><div class="dc-v">${val}</div>`}</div>`;
  // 手机卡片版(桌面隐藏)。v1.9.6（用户要求）：总览不再显示「近30天过期」——
  // TRAE 签到包 30 天有效、先到期的先被消耗，1~7 天内基本恒为 0，到期压力天然全落在
  // 8~30 天这一档，该档数字常年巨大却从不催行动（真正急的近2/3/7天还在）；要看明细
  // 弹窗里仍保留「📅 近30天过期」。expiring30d 派生照常计算，只摘总览展示。
  const cards = dashPer.map((a, i) => {
    const tu = a.todayUsed || 0;
    const e2 = a.expiring2d || 0, e3 = a.expiring3d || 0, e7 = a.expiring7d || 0;
    return `<div class="dacct">
      <div class="dhead">
        <span class="di">${i + 1}</span>
        <span class="dname">${escAttr(acctName(a))}</span>
      </div>
      <div class="dremain"><div class="dr-v">${fmt0(a.currentRemain ?? "-")}</div><div class="dr-l">💎 总剩余</div></div>
      <div class="dgrid">
        ${cell("今日消耗", fmt0(tu), "", "plain", false)}
        ${cell("累计已用", fmt0(a.consumed ?? "-"), "", "plain", false)}
        ${cell("近2天过期", fmt0(e2), e2 > 0 ? "warn" : "", e2 > 0 ? "warn" : "ok", e2 > 0)}
        ${cell("近3天过期", fmt0(e3), e3 > 0 ? "warn" : "", e3 > 0 ? "warn" : "ok", e3 > 0)}
        ${cell("近7天过期", fmt0(e7), e7 > 0 ? "warn" : "", e7 > 0 ? "warn" : "ok", e7 > 0)}
      </div>
    </div>`;
  }).join("");
  const sum = (k) => dashPer.reduce((s, x) => s + (x[k] || 0), 0);
  const sumExp1d = dashPer.reduce((s, a) => s + (a.expiring1d || 0), 0);
  const sumExp2d = dashPer.reduce((s, a) => s + (a.expiring2d || 0), 0);
  const sumExp3d = dashPer.reduce((s, a) => s + (a.expiring3d || 0), 0);
  const sumExp7d = dashPer.reduce((s, a) => s + (a.expiring7d || 0), 0);
  const sumTu = dashPer.reduce((s, a) => s + (a.todayUsed || 0), 0);
  // 合计卡跨整行
  const total = `<div class="dacct dtot">
    <div class="dhead"><div class="dname num-b">📊 合计</div></div>
    <div class="dgrid">
      ${cell("今日消耗", fmt0(sumTu), "", "plain", false)}
      ${cell("累计已用", fmt0(sum("consumed")), "", "plain", false)}
      ${cell("近2天过期", fmt0(sumExp2d), sumExp2d > 0 ? "warn" : "", sumExp2d > 0 ? "warn" : "ok", sumExp2d > 0)}
      ${cell("近3天过期", fmt0(sumExp3d), sumExp3d > 0 ? "warn" : "", sumExp3d > 0 ? "warn" : "ok", sumExp3d > 0)}
      ${cell("近7天过期", fmt0(sumExp7d), sumExp7d > 0 ? "warn" : "", sumExp7d > 0 ? "warn" : "ok", sumExp7d > 0)}
    </div>
    <div class="dremain" style="background:none;border:none;padding:6px 0 0"><div class="dr-v" style="font-size:22px;background:var(--grad);-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent">${fmt0(sum("currentRemain"))}</div><div class="dr-l">💎 总剩余</div></div>
  </div>`;
  $("dashCards").innerHTML = cards + total;
  // ===== 桌面表格版(手机隐藏)。v1.10.0:动态 thead(可排序) + 筛选/视图排序 + 状态点 + 吸底合计 =====
  // 排序:W3C ARIA —— th 内 button、aria-sort 全表唯一、未排序列预留 ⇕ 槽位(点击不跳宽)
  const th = (c) => {
    // v1.12.9：近2/3/7 天不再可排序（用户：这几列的标题不需要排序）。近1天已带「全 0 降级」
    // （见 expSortTier），相邻档位再各自可点只会制造"点哪列都差不多、但结果又不一样"的困惑。
    if (c.sortable === false) return `<th class="c-${c.key}" style="text-align:right">${c.label}</th>`;
    const s = viewSort && viewSort.key === c.key;
    const ic = s ? (viewSort.dir === "desc" ? "▼" : "▲") : "⇕";
    const aria = s ? ` aria-sort="${viewSort.dir === "desc" ? "descending" : "ascending"}"` : "";
    return `<th class="c-${c.key}"${aria} style="text-align:right"><button class="th-btn" onclick="setViewSort('${c.key}')">${c.label} <span class="sort-ic${s ? " on" : ""}">${ic}</span></button></th>`;
  };
  $("dashThead").innerHTML = `<tr><th class="c-name" style="text-align:left">账号</th>${VIEW_SORTS.map(th).join("")}<th class="c-st" style="text-align:center">状态</th></tr>`;
  // 筛选 + 视图排序(null=池序)。无数据(null/undefined)恒垫底,不冒充 0 参与比较
  const sortBy = viewSort ? VIEW_SORTS.find((s) => s.key === viewSort.key) : null;
  const rows0 = dashPer.filter((a) =>
    viewFilter === "all" ? true :
    viewFilter === "warn" ? warnOf(a) :
    a.appKey === viewFilter
  );
  // v1.12.10：近1天排序 = **逐级比较**（字典序 tiebreak），不是"挑一档来排"。
  // 用户：「近2天一样的时候，就看近3天，近3天一样，就看近7天 这样排序」。
  // 即比较器按 近1天→近2天→近3天→近7天 依次比，上一档相等才看下一档；
  // 「近1天全员 0」只是这条链的第一个"全相等"特例，天然被 tiebreak 吃掉，
  // 不再需要先判定档位再单键排序（v1.12.9 的做法：同档平局会退回池序，正是用户看到的错）。
  const sortChain = sortBy
    ? (sortBy.cascade ? VIEW_SORTS.filter((s) => s.key.startsWith("exp")) : [sortBy])
    : [];
  const rows1 = sortBy
    ? [...rows0].sort((x, y) => {
        for (const s of sortChain) {
          const vx = s.get(x), vy = s.get(y);
          if (vx == null && vy == null) continue;
          if (vx == null) return 1;   // 无数据恒垫底
          if (vy == null) return -1;
          if (vx === vy) continue;    // 本档平局 → 看下一档
          return viewSort.dir === "desc" ? vy - vx : vx - vy;
        }
        return 0;                     // 四档全平 → 稳定排序保持池序
      })
    : rows0;
  const dot = (c, t) => `<span class="dot dot-${c}" title="${escAttr(t)}"></span>`;
  const rows = rows1.map((a) => {
    const e1 = a.expiring1d || 0, e2 = a.expiring2d || 0, e3 = a.expiring3d || 0, e7 = a.expiring7d || 0;
    const st = statusOf(a);
    const exc = st.c !== "ok" ? ` style="box-shadow:inset 3px 0 0 var(--${st.c === "warn" ? "warn" : "bad"})"` : "";
    return `<tr${exc} onclick="openDetail('${a.id}')" title="点击查看明细">
    <td class="c-name">${escAttr(acctName(a))} <span class="src-tag">${a.appKey === "workbuddy" ? "WB" : "TRAE"}</span></td>
    <td class="num c-remain"><b>${a.currentRemain == null ? "-" : fmt0(a.currentRemain)}</b></td>
    <td class="num c-today">${a.todayUsed > 0 ? fmt0(a.todayUsed) : "0"}</td>
    <td class="num c-consumed">${a.consumed == null ? "-" : fmt0(a.consumed)}</td>
    <td class="num c-exp1" style="color:var(--${e1 > 0 ? 'warn' : 'faint'})">${fmt0(e1)}</td>
    <td class="num c-exp2" style="color:var(--${e2 > 0 ? 'warn' : 'faint'})${e2 > 0 ? ';font-weight:800' : ''}">${fmt0(e2)}</td>
    <td class="num c-exp3" style="color:var(--${e3 > 0 ? 'warn' : 'faint'})">${fmt0(e3)}</td>
    <td class="num c-exp7" style="color:var(--${e7 > 0 ? 'warn' : 'faint'})${e7 > 0 ? ';font-weight:800' : ''}">${fmt0(e7)}</td>
    <td class="c-st" style="text-align:center">${dot(st.c, st.t)}</td></tr>`;
  }).join("");
  $("dashTbody").innerHTML = (rows || '<tr><td colspan="9" class="ph">该筛选下暂无账号</td></tr>');
  // 合计 = 全部账号(不随筛选变,口径是"池"而不是"当前透镜"),吸底常显
  const warnAll = dashPer.filter(warnOf).length;
  $("dashTfoot").innerHTML = `<tr class="row-total">
    <td class="c-name">合计</td><td class="num c-remain">${fmt0(sum("currentRemain"))}</td><td class="num c-today">${fmt0(sumTu)}</td><td class="num c-consumed">${fmt0(sum("consumed"))}</td>
    <td class="num c-exp1">${fmt0(sumExp1d)}</td><td class="num c-exp2">${fmt0(sumExp2d)}</td><td class="num c-exp3">${fmt0(sumExp3d)}</td><td class="num c-exp7">${fmt0(sumExp7d)}</td>
    <td class="c-st" style="text-align:center;color:var(--${warnAll ? "warn" : "faint"})">${warnAll || "—"}</td></tr>`;
}

// ---- v1.10.0 总览工具条:来源/例外筛选 chips + 视图排序状态(列头点击排序,只改视图不改池序) ----
// 排序列定义:get 取值函数 null 视为无数据(排序恒垫底,不冒充 0)
// v1.12.9:sortable:false = 表头不给按钮（近2/3/7 天仅供阅读）;cascade:true = 带「全 0 降级」
const VIEW_SORTS = [
  { key: "remain", label: "总剩余", get: (a) => a.currentRemain },
  { key: "today", label: "今日消耗", get: (a) => (a.todayUsed || 0) },
  { key: "consumed", label: "累计已用", get: (a) => a.consumed },
  { key: "exp1", label: "近1天", get: (a) => (a.expiring1d || 0), cascade: true },
  { key: "exp2", label: "近2天", get: (a) => (a.expiring2d || 0), sortable: false },
  { key: "exp3", label: "近3天", get: (a) => (a.expiring3d || 0), sortable: false },
  { key: "exp7", label: "近7天", get: (a) => (a.expiring7d || 0), sortable: false },
];
// v1.12.10：`expSortTier` 现在**只服务展示**（"第一档真正有区分度的是哪一档"），
// 排序本身不再挑档 —— 比较器在 renderDashTable 里按 近1天→近2天→近3天→近7天 逐级比。
// 返回值只用来决定工具条要不要写"近1天全为 0"这句说明。
function expSortTier(rows) {
  const chain = VIEW_SORTS.filter((s) => s.key.startsWith("exp"));
  const hit = chain.find((s) => rows.some((a) => (s.get(a) || 0) > 0));
  return (hit || chain[0] || { key: "exp1" }).key;
}
function setViewFilter(f) {
  viewFilter = f;
  renderHero(); // 同步 KPI 里「需关注」格的高亮态(它与筛选共用同一口径)
  renderDash();
}
function setViewSort(key) {
  // 三态循环(W3C 惯例):未排 → 降序 → 升序 → 回池序;同一时刻只有一列携带 aria-sort
  if (!viewSort || viewSort.key !== key) viewSort = { key, dir: "desc" };
  else if (viewSort.dir === "desc") viewSort = { key, dir: "asc" };
  else viewSort = null;
  renderDash();
}
// v1.12.8:✕（清除排序）专用 —— 之前它 onclick 的是 setViewSort(key)，等于又走一遍
// 三态循环：从默认的「近1天 ↓」点一次变 ↑、点第二次才回池序，用户体感"要关两次"。
function clearViewSort() {
  viewSort = null;
  renderDash();
}
function renderDashTools() {
  const per = dashPer || [];
  const cnt = {
    all: per.length,
    traework: per.filter((a) => a.appKey === "traework").length,
    workbuddy: per.filter((a) => a.appKey === "workbuddy").length,
    warn: per.filter(warnOf).length,
  };
  const chip = (f, label, warn) =>
    `<button class="chip${viewFilter === f ? " active" : ""}${warn ? " chip-warn" : ""}" onclick="setViewFilter('${f}')">${label} ${cnt[f]}</button>`;
  const sort = viewSort ? VIEW_SORTS.find((s) => s.key === viewSort.key) : null;
  // v1.12.10：降级的真实语义是「逐级比较」，文案照实写；不写出来，用户只会觉得"点了近1天却像按近7天排"。
  // 只有"近1天全员 0"这一种需要解释（否则近1天本档就有区分度，无需提示）。
  let tierNote = "";
  if (sort && sort.cascade && expSortTier(per) !== sort.key) {
    tierNote = ` <span class="sort-note" title="近1天全为 0：同分时依次按近2天→近3天→近7天比较">· 近1天全为 0 → 按近2→3→7 天逐级</span>`;
  }
  const sortTxt = viewSort
    ? `${sort ? sort.label : ""} ${viewSort.dir === "desc" ? "↓" : "↑"}${tierNote} <button class="chip-x" onclick="clearViewSort()" title="清除排序,恢复池序">✕</button>`
    : "池序";
  $("dtools").innerHTML = `
    ${chip("all", "全部")}${chip("traework", "TRAE")}${chip("workbuddy", "WB")}
    ${chip("warn", "⚠ 需关注", true)}
    <span class="sort-state">排序：${sortTxt}</span>`;
}

// ===== 趋势图表（柱状图/每日窗口/图例交互/模式切换）已拆分到 wb-gui.chart.js =====
