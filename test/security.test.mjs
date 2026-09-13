// test/security.test.mjs - 凭据/账本文件防入库鉴扫（P2）
//
// 防线1: 工具目录 .gitignore 必须覆盖所有含登录态/凭据/时序敏感数据的文件——
//        漏掉任何一个，未来 git 提交时都可能把 cookieHeader/WebDAV 密码/token 送进仓库。
// 防线2: 与 syncbridge 清单真源联动，改清单时如果忘了同步 .gitignore 会被这里拦下。
// 防线3: workbuddy-checkin 子模块必须忽略 config.json/.env/*.info（token 明文）。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url)); // 工具目录
const giText = fs.readFileSync(`${root}.gitignore`, "utf8");
const giCheckinText = fs.readFileSync(`${root}workbuddy-checkin/.gitignore`, "utf8");

// 关键凭据/账本文件名（含登录态或密码，绝不可入库）。wb-sync.json 是 WebDAV 同步配置(用户名+密码)。
const CRED_FILES = [
  "credits.db",
  "credits.db-wal",
  "credits.db-shm",
  "trae-accounts.json", // 含 cookieHeader(账号登录态)
  "trae-history.json", // 含账号行为时序
  "trae-last-data.json",
  "wb-sync.json", // WebDAV 用户名+密码
];

test("工具 .gitignore 覆盖全部凭据/账本文件", () => {
  for (const f of CRED_FILES) {
    assert.ok(giText.includes(f), `.gitignore 必须忽略 ${f}（含登录态/密码）`);
  }
});

test("syncbridge 清单真源与 .gitignore 覆盖闭环", async () => {
  const { SYNC_FILES } = await import("../src/store/syncbridge.js");
  for (const name of SYNC_FILES) {
    assert.ok(giText.includes(name), `.gitignore 必须覆盖清单真源中的 ${name}`);
  }
});

test("workbuddy-checkin 子模块忽略 token 文件", () => {
  for (const p of ["config.json", ".env", "*.info"]) {
    assert.ok(giCheckinText.includes(p), `workbuddy-checkin/.gitignore 必须忽略 ${p}`);
  }
  // 只有示例配置存在，不得有真实 config.json（内含 token）提交
  assert.ok(!fs.existsSync(`${root}workbuddy-checkin/config.json`), "不应存在真实 config.json");
});