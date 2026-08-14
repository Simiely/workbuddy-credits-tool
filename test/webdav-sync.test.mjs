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

  // ---------- T6 备份剥离策略:每天首末快照保留 giftPackages(包级口径不降级) ----------
  console.log("T6 备份剥离策略(每天首末保留 giftPackages,口径不降级)");
  {
    const hist = await import("file:///" + tmp.replace(/\\/g, "/") + "/src/compute/history.js");
    const derive = await import("file:///" + tmp.replace(/\\/g, "/") + "/src/compute/derive.js");
    const TZ_MS = 8 * 3600 * 1000;
    const todayKey = new Date(Date.now() + TZ_MS).toISOString().slice(0, 10);
    const dayStart = (key) => new Date(key + "T00:00:00Z").getTime() - TZ_MS;
    const at = (key, hour) => new Date(dayStart(key) + hour * 3600 * 1000).toISOString();
    // v1.4.43 失效包场景:首条 active 包 A(used=100,end 不变) → 末条 A 用光失效(status=3,used=160,remain=0) + 新增 active 包 C(used=30)
    //   v1.4.63 包级口径 = A 增量 60 + C 增量 30 = 90;降级增量口径(giftUsed 100→105→115)= 15 —— 差异明显,可验证是否降级
    const pkgActive = (used) => [{ packageName: "裂变包", status: 0, capacityRemain: 1000 - used, capacityUsed: used, capacitySize: 1000, cycleEndTime: "2026-08-08 00:00:00" }];
    const pkgExpiredPlusNew = (usedOld, usedNew) => [
      { packageName: "裂变包", status: 3, capacityRemain: 0, capacityUsed: usedOld, capacitySize: 1000, cycleEndTime: "2026-08-08 00:00:00" },
      { packageName: "签到包", status: 0, capacityRemain: 1000 - usedNew, capacityUsed: usedNew, capacitySize: 1000, cycleEndTime: "2026-09-08 00:00:00" },
    ];
    const mk = (ts, packs, totalUsed) => ({ uin: "u1", ts, baseRemain: 500, baseUsed: 0, giftRemain: 100, giftUsed: totalUsed, giftPackages: packs });
    hist.clearReadings();
    hist.appendSnapshot([mk(at(todayKey, 1), pkgActive(100), 100)], { ts: at(todayKey, 1) });   // 首条:active A used=100
    hist.appendSnapshot([mk(at(todayKey, 4), pkgActive(130), 105)], { ts: at(todayKey, 4) });   // 中间
    hist.appendSnapshot([mk(at(todayKey, 8), pkgExpiredPlusNew(160, 30), 115)], { ts: at(todayKey, 8) }); // 末条:A 用光失效+新包 C
    const d0 = derive.deriveAccount("u1");
    assert("原始库 todayUsed = 包级 90(用光失效 A 增量 60 + 新增 C 增量 30)", d0.todayUsed === 90, "got " + d0.todayUsed);

    hist.exportLegacy();
    const mirror = JSON.parse(fs.readFileSync(path.join(tmp, "wb-history.json"), "utf8"));
    const snaps = mirror.snapshots;
    const hasGift = (s) => !!(s.entries && s.entries[0] && s.entries[0].giftPackages);
    assert("快照 3 组", snaps.length === 3, "got " + snaps.length);
    assert("首组保留 giftPackages", hasGift(snaps[0]));
    assert("中间组剥离 giftPackages", !hasGift(snaps[1]));
    assert("末组保留 giftPackages", hasGift(snaps[2]));

    // 恢复到新库,派生必须仍是包级(不降级)
    const tmp3 = fs.mkdtempSync(path.join(os.tmpdir(), "wb-sync-restore-"));
    fs.cpSync(path.join(ROOT, "src"), path.join(tmp3, "src"), { recursive: true });
    const hist3 = await import("file:///" + tmp3.replace(/\\/g, "/") + "/src/compute/history.js");
    const derive3 = await import("file:///" + tmp3.replace(/\\/g, "/") + "/src/compute/derive.js");
    fs.copyFileSync(path.join(tmp, "wb-history.json"), path.join(tmp3, "wb-history.json"));
    hist3.importLegacy();
    const d3 = derive3.deriveAccount("u1");
    assert("恢复库 todayUsed 仍包级 90(首末带包,不降级)", d3.todayUsed === 90, "got " + d3.todayUsed + "(若为 15 则是降级增量口径)");
    try { fs.rmSync(tmp3, { recursive: true, force: true }); } catch {}
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
