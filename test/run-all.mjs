// test/run-all.mjs — 回归测试统一入口
// 用法: node test/run-all.mjs    （或 npm test）
// 依次运行 test/*.test.mjs,任一失败则整体非零退出。
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tests = fs
  .readdirSync(__dirname)
  .filter((f) => f.endsWith(".test.mjs"))
  .sort();

let failed = 0;
for (const t of tests) {
  console.log(`\n========== ${t} ==========`);
  const r = spawnSync(process.execPath, [path.join(__dirname, t)], { stdio: "inherit" });
  if (r.status !== 0) failed++;
}
console.log(`\n========== 结果: ${tests.length - failed}/${tests.length} 通过 ==========`);
process.exit(failed ? 1 : 0);
