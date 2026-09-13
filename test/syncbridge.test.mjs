// test/syncbridge.test.mjs - 同步桥接往返回归（P1，临时库隔离，不碰线上 credits.db）
//
// 锁定现状双写桥接的幂等性，防止收敛改造引入回归：
//   账号仓：exportLegacy → 清空 → importLegacy 应完整恢复；重复 import 不产生重复。
//   历史仓：exportLegacy(含摘要) → 清空 readings+day_summary → importLegacy 应完整恢复快照与摘要。
//   清单：syncbridge.SYNC_FILES 必须与 ACCOUNTS_FILE / HISTORY_FILE 的 basename 一致(收敛真源)。
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { before, test } from "node:test";
import assert from "node:assert/strict";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "trae-sync-"));
process.env.TRAE_TOOLS_DIR = tmp;

const store = await import("../src/compute/store.js");
const hist = await import("../src/compute/history.js");
const { SYNC_FILES, ACCOUNTS_FILE, HISTORY_FILE } = await import("../src/store/syncbridge.js");
const { getDb } = await import("../src/store/db.js");
const { cnDay0 } = await import("../src/time.js");

const UIN = "sync-uin-1";
const DAY_MS = 86400000;

// 造一条历史 reading（显式 ts，同 db.derive.test 的语义）
function seedReading(tsMs, giftUsed) {
  // 生产 appendSnapshot 的 entry 恒含 uin(readings 列 + raw 内都带)，往返导出→导入依赖它归位账号
  getDb()
    .prepare("INSERT INTO readings (uin,ts,baseRemain,baseUsed,giftRemain,giftUsed,raw) VALUES (?,?,?,?,?,?,?)")
    .run(
      UIN,
      new Date(tsMs).toISOString(),
      null, 0, 1000, giftUsed,
      JSON.stringify({ uin: UIN, giftRemain: 1000, giftUsed, baseRemain: null, baseUsed: 0, giftPackages: [] })
    );
}

before(() => {
  store.saveAccounts([
    { id: "a1", name: "n1", uin: "9001", cookieHeader: "k1", appKey: "traework" },
    { id: "a2", name: "n2", uin: "9002", cookieHeader: "k2", appKey: "workbuddy" },
  ]);
  // 今天两条 + T-2 两条。注意 cnDay0 返回 Date，Date+数字会走字符串拼接，
  // 必须 .getTime() 拿到毫秒，否则"今日"偏移全部塌缩到 t0。
  const t0 = cnDay0(Date.now()).getTime();
  seedReading(t0 + 6 * 3600e3, 1000);
  seedReading(t0 + 7 * 3600e3, 1050);
  seedReading(t0 - 2 * DAY_MS + 12 * 3600e3, 30);
  seedReading(t0 - 2 * DAY_MS + 13 * 3600e3, 60);
});

test("syncbridge: 文件清单真源与路径一致", () => {
  assert.deepEqual(SYNC_FILES, ["trae-accounts.json", "trae-history.json"]);
  assert.equal(path.basename(ACCOUNTS_FILE), SYNC_FILES[0]);
  assert.equal(path.basename(HISTORY_FILE), SYNC_FILES[1]);
});

test("账号仓往返：导出→清空→导入 完整恢复且幂等", () => {
  store.exportLegacy();
  assert.ok(fs.existsSync(ACCOUNTS_FILE), "应导出账号镜像文件");
  const j = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, "utf8"));
  assert.equal(j.accounts.length, 2);

  store.clearAccounts();
  assert.equal(store.loadAccounts().length, 0);

  store.importLegacy();
  const after1 = store.loadAccounts();
  assert.equal(after1.length, 2, "导入后账号恢复");
  assert.ok(after1.some((a) => a.uin === "9001"));

  store.importLegacy(); // 幂等:重复导入不重复
  assert.equal(store.loadAccounts().length, 2);
});

test("历史仓往返：导出→清空快照+摘要→导入 完整恢复且不重复", () => {
  hist.exportLegacy();
  assert.ok(fs.existsSync(HISTORY_FILE), "应导出历史镜像");
  const j = JSON.parse(fs.readFileSync(HISTORY_FILE, "utf8"));
  assert.ok(j.snapshots.length >= 4, "镜像应含未固化快照");
  assert.ok(Array.isArray(j.summaries));

  hist.clearDaySummaries();
  getDb().prepare("DELETE FROM readings").run();
  assert.equal(hist.historyFor(UIN).length, 0, "清空后无快照");

  hist.importLegacy();
  const restored = hist.historyFor(UIN);
  assert.ok(restored.length >= 4, "导入后快照恢复");
  // 最新一条被恢复且值一致
  assert.equal(restored[restored.length - 1].giftUsed, 1050);
});