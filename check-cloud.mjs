// 检查云端 WebDAV 备份完整性(只读)
import { loadSyncConfig, downloadFile, BACKUP_DIR } from "./src/compute/webdav.js";

const cfg = loadSyncConfig();
const base = cfg.url.replace(/\/+$/, "");

for (const f of ["wb-accounts.json", "wb-history.json", "wb-last-data.json"]) {
  const t0 = Date.now();
  try {
    const txt = await downloadFile(base, cfg.user, cfg.pass, BACKUP_DIR, f);
    if (!txt) { console.log(f, ": 云端不存在!"); continue; }
    if (f === "wb-history.json") {
      const j = JSON.parse(txt);
      const snaps = j.snapshots || [];
      const days = {};
      for (const s of snaps) { const d = (s.ts || "").slice(0, 10); days[d] = (days[d] || 0) + 1; }
      const kb = (txt.length / 1024).toFixed(0);
      const dayStr = Object.entries(days).map(([d, c]) => d + "x" + c).join(" ");
      console.log(f + ": " + kb + "KB, 快照 " + snaps.length + " 条, 按天: " + dayStr);
    } else if (f === "wb-accounts.json") {
      const j = JSON.parse(txt);
      console.log(f + ": " + (txt.length / 1024).toFixed(0) + "KB, 账号 " + (j.accounts || []).length + " 个");
    } else {
      console.log(f + ": " + (txt.length / 1024).toFixed(0) + "KB");
    }
    console.log("  下载耗时 " + ((Date.now() - t0) / 1000).toFixed(1) + "s");
  } catch (e) {
    console.log(f + ": 下载失败 " + e.message.slice(0, 80));
  }
}
