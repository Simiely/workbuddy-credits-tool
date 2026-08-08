// test/webdav-sync.test.mjs — 一键同步回归（v1.4.46：smart 合并 + 墓碑删除传播 + 导出往返 + TTL）
// 运行: node test/webdav-sync.test.mjs
// 隔离方式: 复制 src/ 到系统临时目录运行(TOOLS_DIR 指向临时目录,绝不触碰真实 credits.db)。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wb-sync-test-"));
fs.cpSync(path.join(ROOT, "src"), path.join(tmp, "src"), { recursive: true });

let passed = 0, failed = 0;
const assert = (n, c, x = "") => { if (c) { passed++; console.log("  PASS " + n); } else { failed++; console.log("  FAIL " + n + (x ? "  << " + x : "")); } };

try {
  const store = await import("file:///" + tmp.replace(/\\/g, "/") + "/src/compute/store.js");

  // ---------- T1 smart 合并基础:双方取新 / 仅远端导入 / 仅本地保留 ----------
  console.log("T1 smart 合并基础(双向取最新)");
  {
    const local = [{ id: "l1", uin: "1", name: "老", updatedAt: "2026-08-01T10:00:00.000Z" }];
    const incoming = [
      { id: "r1", uin: "1", name: "新", updatedAt: "2026-08-02T10:00:00.000Z" }, // 远端更新 → 覆盖
      { id: "r2", uin: "2", name: "仅远端", updatedAt: "2026-08-01T00:00:00.000Z" }, // 仅远端 → 导入
    ];
    const st = store.mergeAccountsSmart(local, incoming, new Map());
    assert("远端新数据覆盖本地(updated=1)", st.updated === 1, JSON.stringify(st));
    assert("仅远端账号导入(added=1)", st.added === 1);
    assert("本地账号 name 被更新", local.find((a) => a.uin === "1").name === "新");
    assert("本地 id 保留(同步不换标识)", local.find((a) => a.uin === "1").id === "l1");
    assert("仅远端账号已入池", local.some((a) => a.uin === "2"));
    // 再次合并旧远端 → 本地更新 → 跳过
    const st2 = store.mergeAccountsSmart(local, [{ id: "r1", uin: "1", name: "更旧", updatedAt: "2026-08-01T09:00:00.000Z" }], new Map());
    assert("旧远端不覆盖本地新数据(skipped=1)", st2.skipped === 1 && st2.updated === 0);
    assert("本地 name 仍是 新", local.find((a) => a.uin === "1").name === "新");
  }

  // ---------- T2 墓碑:删除传播 / 删除不生效 ----------
  console.log("T2 墓碑(删除传播与保护)");
  {
    // 2a 删除传播:本地活跃 + 墓碑更新 → 本地移除
    const local = [{ id: "l1", uin: "1", name: "A", updatedAt: "2026-08-01T10:00:00.000Z" }];
    const st = store.mergeAccountsSmart(local, [], new Map([["1", "2026-08-05T00:00:00.000Z"]]));
    assert("墓碑更新 → 删除传播(tombstoned=1)", st.tombstoned === 1, JSON.stringify(st));
    assert("本地账号被移除", !local.some((a) => a.uin === "1"));

    // 2b 删除不生效:本地 updatedAt > deletedAt → 保留
    const local2 = [{ id: "l2", uin: "2", name: "B", updatedAt: "2026-08-06T00:00:00.000Z" }];
    const st2 = store.mergeAccountsSmart(local2, [], new Map([["2", "2026-08-05T00:00:00.000Z"]]));
    assert("本地删后又更新 → 保留(删除不生效)", st2.tombstoned === 0 && local2.length === 1, JSON.stringify(st2));
  }

  // ---------- T3 墓碑:复活 / 保持删除 ----------
  console.log("T3 墓碑(复活与保持删除)");
  {
    // 3a 远端新数据 > 墓碑 → 复活导入
    const local = [];
    const st = store.mergeAccountsSmart(local, [{ id: "r1", uin: "1", name: "复活", updatedAt: "2026-08-07T00:00:00.000Z" }], new Map([["1", "2026-08-05T00:00:00.000Z"]]));
    assert("远端新数据复活(resurrected=1)", st.resurrected === 1, JSON.stringify(st));
    assert("复活账号已入池", local.some((a) => a.uin === "1"));

    // 3b 远端数据比墓碑旧 → 保持删除(跳过,不导入)
    const local2 = [];
    const st2 = store.mergeAccountsSmart(local2, [{ id: "r2", uin: "2", name: "旧数据", updatedAt: "2026-08-01T00:00:00.000Z" }], new Map([["2", "2026-08-05T00:00:00.000Z"]]));
    assert("墓碑比远端数据新 → 保持删除(skipped=1)", st2.skipped === 1 && local2.length === 0, JSON.stringify(st2));
  }

  // ---------- T4 墓碑随备份导出/导入往返 ----------
  console.log("T4 墓碑随 wb-accounts.json 备份传播");
  {
    store.tombstoneUins(["99", "100"]);
    store.exportLegacy();
    const j = JSON.parse(fs.readFileSync(path.join(tmp, "wb-accounts.json"), "utf8"));
    assert("导出含 tombstones 字段", Array.isArray(j.tombstones) && j.tombstones.length === 2, JSON.stringify(j.tombstones));
    // 清空墓碑后从备份恢复(模拟另一台设备下载)
    store.purgeOldTombstones(0); // TTL=0 → 全部清理(测试用)
    assert("墓碑已清空", store.loadTombstones().size === 0);
    store.importLegacy();
    const tombs = store.loadTombstones();
    assert("导入恢复墓碑(99/100)", tombs.has("99") && tombs.has("100"));
  }

  // ---------- T5 purgeOldTombstones TTL 清理 ----------
  console.log("T5 过期墓碑 TTL 清理");
  {
    const db = (await import("file:///" + tmp.replace(/\\/g, "/") + "/src/store/db.js")).getDb();
    const old = new Date(Date.now() - 31 * 86400000).toISOString();
    const ins = db.prepare("INSERT OR REPLACE INTO tombstones (uin, deletedAt) VALUES (?, ?)");
    ins.run("old1", old);
    ins.run("new1", new Date().toISOString());
    const n = store.purgeOldTombstones();
    assert("仅清理 30 天前墓碑", store.loadTombstones().has("old1") === false && store.loadTombstones().has("new1") === true, "cleared=" + n);
  }
} catch (e) {
  console.log("  FAIL 测试执行异常: " + e.message);
  console.log(e.stack);
  failed++;
} finally {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
}

console.log(`\n===== ${passed} passed, ${failed} failed =====`);
process.exit(failed ? 1 : 0);
