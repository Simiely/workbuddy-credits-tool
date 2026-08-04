// src/store/migrate.js - 一次性迁移脚本（幂等，可重跑）
// 把遗留 JSON（wb-accounts.json / wb-history.json）导入 SQLite（credits.db）。
//   node src/store/migrate.js        普通迁移（库非空则跳过）
//   node src/store/migrate.js --force 清空后重新导入
import { getDb, migrateFromLegacy, DB_PATH } from "./db.js";

const force = process.argv.includes("--force");
const r = migrateFromLegacy(force);
const db = getDb();
const acc = db.prepare("SELECT COUNT(*) AS c FROM accounts").get().c;
const rd = db.prepare("SELECT COUNT(*) AS c FROM readings").get().c;
console.log(`credits.db: ${DB_PATH}`);
console.log(`accounts=${acc}  readings=${rd}`);
if (r.skipped) console.log("（已存在数据，跳过；用 --force 可重导）");
else console.log(`迁移完成: accounts=${r.accounts ?? acc}  readings=${r.readings ?? rd}`);
