// test/paths.test.mjs - 平台版/换机凭证路径自愈(resolveSlotPath + rewriteAccountPaths)
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let TMP = "";
const mod = await (async () => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), "paths-test-"));
  process.env.TRAE_TOOLS_DIR = TMP;
  return await import("../src/compute/paths.js");
})();
const { resolveSlotPath, rewriteAccountPaths } = mod;

function mk(rel, content = "{}") {
  const p = path.join(TMP, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, "utf8");
  return p;
}

const brokenWb = "C:\\Users\\x\\Desktop\\LoginStateSwitcherOnedir-v5\\backups\\workbuddy\\小黄\\workbuddy-desktop.info"; // 平台版不存在的路径
const brokenTrae = "C:\\Users\\x\\Desktop\\MultiSwitch\\backups\\trae\\小陈\\User\\globalStorage\\storage.json";

test("resolveSlotPath: 失效 workbuddy 路径 → 命中本地已拉取槽", () => {
  mk("backups/workbuddy/小黄/workbuddy-desktop.info",
    JSON.stringify({ auth: {}, account: { uid: "uid-小黄" } }));
  const got = resolveSlotPath({ cookieHeader: brokenWb, appKey: "workbuddy", displayName: "小黄", name: "小黄", uin: "uid-小黄" });
  assert.equal(got, path.join(TMP, "backups", "workbuddy", "小黄", "workbuddy-desktop.info"));
});

test("resolveSlotPath: 失效 trae 路径 → 命中本地槽的 storage.json", () => {
  mk("backups/trae/小陈/User/globalStorage/storage.json", "{}");
  const got = resolveSlotPath({ cookieHeader: brokenTrae, appKey: "traework", displayName: "小陈 trae", name: "世界的风吹向你", uin: "422" });
  assert.equal(got, path.join(TMP, "backups", "trae", "小陈", "User", "globalStorage", "storage.json"));
});

test("resolveSlotPath: uid 不符的同名槽不误配(workbuddy)", () => {
  // 槽名"小黄"名命中,但 .info 内 uid 与账号 uin 不一致 → 不应返回
  const got = resolveSlotPath({ cookieHeader: brokenWb, appKey: "workbuddy", displayName: "小黄", name: "小黄", uin: "other-uid" });
  assert.equal(got, "");
});

test("resolveSlotPath: 有效路径原样返回; 内联 JSON 原样返回", () => {
  const valid = mk("real.info", "{}");
  assert.equal(resolveSlotPath({ cookieHeader: valid, appKey: "workbuddy" }), valid);
  assert.equal(resolveSlotPath({ cookieHeader: '{ "token": "abc" }', appKey: "workbuddy" }), '{ "token": "abc" }');
});

test("rewriteAccountPaths: 失效桌面路径按槽名重写到本地槽", () => {
  const accts = [
    { cookieHeader: brokenWb, appKey: "workbuddy" },
    { cookieHeader: brokenTrae, appKey: "traework" },
    { cookieHeader: path.join(TMP, "real.info"), appKey: "workbuddy" }, // 有效不动
  ];
  const n = rewriteAccountPaths(accts);
  assert.equal(n, 2);
  assert.equal(accts[0].cookieHeader, path.join(TMP, "backups", "workbuddy", "小黄", "workbuddy-desktop.info"));
  assert.equal(accts[1].cookieHeader, path.join(TMP, "backups", "trae", "小陈", "User", "globalStorage", "storage.json"));
  assert.equal(accts[2].cookieHeader, path.join(TMP, "real.info"));
});