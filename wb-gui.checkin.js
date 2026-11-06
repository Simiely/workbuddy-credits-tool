// wb-gui.checkin.js - 「补签未签」按钮（v1.12.12）
// 依赖：wb-gui.state.js($)、wb-gui.core.js(api/toast)、wb-gui.actions.js(refreshAll)。
// 只在 actions.js 之后加载；后端 POST /api/checkin/run {"onlyMissing":true} 异步执行。
let _patchBusy = false;

async function _patchStatus() {
  return await api(__BASE__ + "/api/checkin/status");
}

async function patchCheckin() {
  if (_patchBusy) { toast("补签正在执行中，请稍候…"); return; }
  if (!window.confirm("只补签「今日未签到」的账号，已签到的会自动跳过。\n确认执行？")) return;
  const btn = $("btnPatchCheckin");
  const html = btn ? btn.innerHTML : "";
  _patchBusy = true;
  if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spin"></span><span class="txt">补签中…</span>'; }
  try {
    let lastRunAt = "";
    try { const s0 = await _patchStatus(); lastRunAt = (s0.state && s0.state.lastRunAt) || ""; } catch {}
    const r = await api(__BASE__ + "/api/checkin/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ onlyMissing: true }),
      timeout: 30000,
    });
    if (!r.ok) throw new Error(r.error || "启动失败");
    toast("补签已启动，正在等待结果…");
    let done = null;
    for (let i = 0; i < 80; i++) {
      await new Promise((res) => setTimeout(res, 3000));
      let s;
      try { s = await _patchStatus(); } catch { continue; }
      if (s.inFlight) continue;
      const ts = (s.state && s.state.lastRunAt) || "";
      if (ts && ts !== lastRunAt) { done = s; break; }
    }
    if (!done) { toast("补签仍在后台执行，请稍后点「刷新全部」查看"); return; }
    const h = (done.history && done.history[done.history.length - 1]) || {};
    const rows = h.rows || [];
    const added = rows.filter((x) => x.result === "added").length;
    const failedRows = rows.filter((x) => x.result === "failed");
    const lr = done.state && done.state.lastResult;
    const skipped = typeof h.skipped === "number" ? h.skipped : (lr && lr.skipped) || 0;
    const msg = `补签完成：成功 ${added} 个，跳过 ${skipped} 个，失败 ${failedRows.length} 个`;
    toast(msg);
    if (failedRows.length) {
      const detail = failedRows.map((x) => `${x.name}: ${x.msg || "失败"}`).join("\n");
      window.alert(msg + "\n\n失败明细：\n" + detail);
    }
    try { await refreshAll(false); } catch {}
  } catch (e) {
    toast("补签失败：" + (e && e.message ? e.message : e));
  } finally {
    _patchBusy = false;
    if (btn) { btn.disabled = false; btn.innerHTML = html; }
  }
}
