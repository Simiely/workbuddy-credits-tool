// test/model-parse.test.mjs — 领域模型解析回归（v1.4.69）
// 场景:基础包(体验版)的 CapacityRemain 是满额(500),不反映周期内消耗;
//       官方 UI 的"版本基础用量剩余"用 CycleCapacityRemain(393.08)。
//       修复后 parseAccountData 基础包应取 Cycle* 字段(缺失兜底 Capacity*)。
// 运行: node test/model-parse.test.mjs    （run-all.mjs 自动纳入）
// 隔离方式: 复制 src/ 到系统临时目录,绝不触碰真实 credits.db。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wb-model-test-"));
fs.cpSync(path.join(ROOT, "src"), path.join(tmp, "src"), { recursive: true });

let passed = 0, failed = 0;
const assert = (n, c, x = "") => { if (c) { passed++; console.log("  PASS " + n); } else { failed++; console.log("  FAIL " + n + (x ? "  << " + x : "")); } };

try {
  const model = await import("file:///" + tmp.replace(/\\/g, "/") + "/src/compute/model.js");

  // 构造真实 API 响应结构(2026-08-31 爸爸实测)
  const basePkg = {
    PackageName: "CodeBuddy个人体验版",
    Status: 0,
    CapacityRemain: 500,        // 满额(旧口径误用)
    CapacityUsed: 0,
    CapacitySize: 500,
    CycleCapacityRemain: 393.08, // 实际周期剩余(官方 UI 口径)
    CycleCapacityUsed: 106.92,
    CycleCapacitySize: 500,
    CycleEndTime: "2026-08-31 23:59:59",
  };
  const giftPkgs = [
    { PackageName: "CodeBuddy个人版国内运营裂变包", Status: 0, CapacityRemain: 100, CapacityUsed: 0, CapacitySize: 100, CycleCapacityRemain: 100, CycleCapacityUsed: 0, CycleCapacitySize: 100, CycleEndTime: "2026-09-01 01:27:17" },
    { PackageName: "CodeBuddy个人版国内运营裂变包", Status: 0, CapacityRemain: 50, CapacityUsed: 0, CapacitySize: 50, CycleCapacityRemain: 50, CycleCapacityUsed: 0, CycleCapacitySize: 50, CycleEndTime: "2027-02-06 18:51:55" },
    { PackageName: "CodeBuddy个人版国内运营裂变包", Status: 3, CapacityRemain: 0, CapacityUsed: 100, CapacitySize: 100, CycleCapacityRemain: 0, CycleCapacityUsed: 100, CycleCapacitySize: 100, CycleEndTime: "2026-08-31 18:16:21" },
  ];
  const D = { Accounts: [basePkg, ...giftPkgs] };

  console.log("T1 基础包取 Cycle* 字段(v1.4.69 修复)");
  const m = model.parseAccountData(D);
  assert("baseRemain = CycleCapacityRemain(393.08)", m.baseRemain === 393.08, "got " + m.baseRemain);
  assert("baseUsed = CycleCapacityUsed(106.92)", m.baseUsed === 106.92, "got " + m.baseUsed);
  assert("baseSize = 500", m.baseSize === 500, "got " + m.baseSize);
  assert("baseCycleEnd 不变", m.baseCycleEnd === "2026-08-31 23:59:59", "got " + m.baseCycleEnd);
  assert("giftRemain 仍用 Capacity*(150)", m.giftRemain === 150, "got " + m.giftRemain);
  assert("giftUsed 只算 active(0)", m.giftUsed === 0, "got " + m.giftUsed);
  assert("expCount 含用光失效(1)", m.expCount === 1, "got " + m.expCount);
  assert("totalRemain = 393.08+150", Math.abs(m.totalRemain - 543.08) < 0.001, "got " + m.totalRemain);

  console.log("T2 无 Cycle* 字段时兜底回 Capacity*(兼容旧接口)");
  const oldBase = { PackageName: "CodeBuddy个人体验版", Status: 0, CapacityRemain: 500, CapacityUsed: 0, CapacitySize: 500, CycleEndTime: "2026-08-31 23:59:59" };
  const m2 = model.parseAccountData({ Accounts: [oldBase] });
  assert("baseRemain 兜底 = CapacityRemain(500)", m2.baseRemain === 500, "got " + m2.baseRemain);
  assert("baseUsed 兜底 = CapacityUsed(0)", m2.baseUsed === 0, "got " + m2.baseUsed);

  console.log("T3 无体验版包 → base 字段为 null");
  const m3 = model.parseAccountData({ Accounts: [] });
  assert("baseRemain = null", m3.baseRemain === null, "got " + m3.baseRemain);
  assert("totalRemain = 0", m3.totalRemain === 0, "got " + m3.totalRemain);

  console.log("T4 buildSnapshotEntry 透传 Cycle* 解析结果");
  const entry = model.buildSnapshotEntry({ account: { uin: "u1", name: "爸爸" }, data: D, summary: m });
  assert("快照 baseRemain = 393.08", entry.baseRemain === 393.08, "got " + entry.baseRemain);
  assert("快照 baseUsed = 106.92", entry.baseUsed === 106.92, "got " + entry.baseUsed);
  assert("快照 giftPackages 3 个", entry.giftPackages.length === 3, "got " + entry.giftPackages.length);
  assert("快照赠送包不含体验版", entry.giftPackages.every((p) => !p.packageName.includes("体验版")), "含体验版");

  console.log("\n结果: " + passed + " 通过, " + failed + " 失败");
  process.exit(failed ? 1 : 0);
} catch (e) {
  console.error("测试异常:", e);
  process.exit(1);
}
