// test/device-pool.test.mjs - 签到设备号去重池回归
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pickDeviceId, registeredDeviceIds, clearDevicePoolCache } from "../src/compute/device-pool.js";

test("registeredDeviceIds: 从槽文件收集全部已登记设备号并去重", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dc-pool-"));
  process.env.TRAE_SLOT_ROOT = root;
  clearDevicePoolCache();
  const ids = ["1111111111111111", "2222222222222222"];
  for (const [i, slot] of ["a", "b"].entries()) {
    const dir = path.join(root, slot, "User", "globalStorage");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "storage.json"),
      JSON.stringify({ ["iCubeAuthInfo://icube-dc:" + ids[i]]: "x" }),
      "utf8"
    );
  }
  assert.deepEqual(registeredDeviceIds().sort(), ids);
  fs.rmSync(root, { recursive: true, force: true });
  delete process.env.TRAE_SLOT_ROOT;
  clearDevicePoolCache();
});

test("pickDeviceId: 同一设备号的多个账号分配到不冲突的值", () => {
  const shared = "4386402410481498";
  clearDevicePoolCache();
  const a = pickDeviceId("uin-a", shared);
  const b = pickDeviceId("uin-b", shared);
  const c = pickDeviceId("uin-c", shared);
  assert.equal(a, shared);
  assert.equal(new Set([a, b, c]).size, 3, "三个账号应拿到三个不同设备号");
  assert.equal(pickDeviceId("uin-a", shared), a, "同一天内分配稳定");
});
