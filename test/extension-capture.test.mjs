// test/extension-capture.test.mjs
// 扩展采集链路回归:mock chrome + fetch,加载真实 background.js,经消息路由验证
//   ① dirUrl 原始中文路径(无 % 编码),与主控 webdav.js 一致
//   ② cookie 清洗:剔除垃圾 cookie + 同名去重,扩展内验证不撞 400
//   ③ 按 Uin 合并多账号(追加不覆盖)
// 运行: node test/extension-capture.test.mjs  (被 test/run-all.mjs 统一调度)
import { fileURLToPath } from "node:url";
import path from "node:path";
import { pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BG = pathToFileURL(path.resolve(__dirname, "../extensions/wb-credits-capture/background.js")).href;

// ---------- 全局 mock ----------
let CURRENT_UIN = "1234567890"; // billing 返回的账号标识,可切换模拟多账号
const webdavStore = new Map();  // URL -> 文件内容(字符串)
const mkcolUrls = [];           // 记录所有 MKCOL 请求 URL(验证目录 URL 以 / 结尾)

if (!globalThis.navigator) globalThis.navigator = { userAgent: "Mozilla/5.0 (Test)" };

function mockResp(status, body) {
  return {
    status,
    ok: status >= 200 && status < 300,
    async json() {
      return typeof body === "string" ? JSON.parse(body) : body;
    },
    async text() {
      return typeof body === "string" ? body : JSON.stringify(body);
    },
  };
}

globalThis.fetch = async (url, opts = {}) => {
  const method = (opts.method || "GET").toUpperCase();
  if (String(url).includes("/billing/meter/get-user-resource")) {
    return mockResp(200, {
      code: 0,
      data: { Response: { Data: { Accounts: [{ Uin: CURRENT_UIN }] } } },
      TotalCount: 5,
      TotalDosage: 100,
    });
  }
  if (method === "PROPFIND") return mockResp(404, ""); // 强制走 MKCOL,覆盖建目录分支
  if (method === "MKCOL") { mkcolUrls.push(String(url)); return mockResp(201, ""); }
  if (method === "GET") {
    const body = webdavStore.get(String(url));
    return body == null ? mockResp(404, "") : mockResp(200, body);
  }
  if (method === "PUT") {
    webdavStore.set(String(url), opts.body || "");
    return mockResp(201, "");
  }
  return mockResp(405, "");
};

const storageMem = {};
globalThis.chrome = {
  cookies: {
    // 故意混入一次性令牌/埋点/同名残留,模拟多次登录后的臃肿 header
    getAll: async () => [
      { name: "KEYCLOAK_IDENTITY", value: "abc", domain: ".workbuddy.cn", expires: 0 },
      { name: "session", value: "sess123", domain: ".workbuddy.cn", expires: Math.floor(Date.now() / 1000) + 86400 },
      { name: "KC_RESTART", value: "x".repeat(1500), domain: ".workbuddy.cn", expires: 0 },
      { name: "sensorsdata", value: "y".repeat(800), domain: "www.workbuddy.cn", expires: 0 },
      { name: "qcloud_visitId", value: "z", domain: ".workbuddy.cn", expires: 0 },
      { name: "trafficParams", value: "p1", domain: ".workbuddy.cn", expires: 0 },
      { name: "trafficParams", value: "p2", domain: ".workbuddy.cn", expires: 0 },
    ],
  },
  storage: {
    local: {
      async get(k) {
        if (typeof k === "string") return storageMem[k] ? { [k]: storageMem[k] } : {};
        if (Array.isArray(k)) {
          const o = {};
          for (const key of k) if (storageMem[key] !== undefined) o[key] = storageMem[key];
          return o;
        }
        return { ...storageMem };
      },
      async set(o) {
        Object.assign(storageMem, o);
      },
      async remove(k) {
        if (typeof k === "string") delete storageMem[k];
        else if (Array.isArray(k)) k.forEach((key) => delete storageMem[key]);
      },
    },
  },
  runtime: {
    onMessage: {
      _h: null,
      addListener(fn) {
        this._h = fn;
      },
    },
  },
};

// ---------- 加载真实 background.js(副作用:注册消息路由) ----------
await import(BG);
const handler = chrome.runtime.onMessage._h;
if (!handler) throw new Error("background.js 未注册消息路由(manifest 是否声明 background.service_worker?)");

function send(msg) {
  return new Promise((resolve) => {
    handler(msg, {}, (r) => resolve(r));
  });
}

// ---------- 断言 ----------
let passed = 0;
function assert(cond, msg) {
  if (!cond) throw new Error("❌ " + msg);
  passed++;
  console.log("  ✓ " + msg);
}

const FILE_URL = "http://192.168.2.1:6086/workbuddy/workbuddy积分/wb-accounts.json";

// 1) 配置 + 路径(原始中文,无 % 编码)
await send({ action: "saveConfig", url: "", user: "tester", pass: "pw" });
const t = await send({ action: "test" });
assert(t.ok === true, "test 动作返回 ok");
assert(t.url === "http://192.168.2.1:6086/workbuddy/workbuddy积分", "dirUrl 为原始中文路径(与主控 webdav.js 一致)");
assert(!t.url.includes("%"), "dirUrl 不含 % 编码(避免 NAS 不解码时拉到 404)");

// 2) 首次抓取并同步(验证 cookie 清洗 + 上传落点)
const s1 = await send({ action: "sync" });
assert(s1.ok === true, "sync 动作返回 ok");
assert(s1.merged === "新增", "首个账号标记为新增");
assert(s1.url === FILE_URL, "上传 URL 与主控读取路径一致");
assert(webdavStore.has(FILE_URL), "wb-accounts.json 已上传到 WebDAV 原始中文路径");

const remote1 = JSON.parse(webdavStore.get(FILE_URL));
assert(Array.isArray(remote1.accounts) && remote1.accounts.length === 1, "远端账号池含 1 个账号");
const acc1 = remote1.accounts[0];
assert(acc1.uin === CURRENT_UIN, "账号 Uin 来自 billing 响应");
assert(typeof acc1.cookieHeader === "string" && acc1.cookieHeader.length > 0, "cookieHeader 已生成");
assert(!acc1.cookieHeader.includes("KC_RESTART"), "清洗后剔除 KC_RESTART 一次性令牌");
assert(!acc1.cookieHeader.includes("sensorsdata"), "清洗后剔除埋点 cookie");
assert(!acc1.cookieHeader.includes("qcloud_"), "清洗后剔除腾讯云埋点");
assert(!/trafficParams=[^;]*;.*trafficParams=/.test(acc1.cookieHeader), "同名 cookie 已去重(只留一份)");
assert(acc1.cookieHeader.includes("KEYCLOAK_IDENTITY="), "保留认证核心 cookie");
assert(acc1.cookieHeader.includes("session="), "保留 session cookie");
assert(acc1.cookieHeader.length <= 7000, "清洗后 header ≤ 7KB(避免网关 400)");

// 3) 切换账号再次同步(按 Uin 合并,追加不覆盖)
CURRENT_UIN = "9876543210";
const s2 = await send({ action: "sync" });
assert(s2.ok === true, "第二次 sync 返回 ok");
assert(s2.merged === "新增", "新 Uin 标记为新增(非覆盖已有)");
const remote2 = JSON.parse(webdavStore.get(FILE_URL));
assert(remote2.accounts.length === 2, "远端账号池已合并为 2 个账号");
const uins = remote2.accounts.map((a) => a.uin).sort();
assert(JSON.stringify(uins) === JSON.stringify(["1234567890", "9876543210"]), "两个账号 Uin 均保留");

// 4) 全 WebDAV 路径均无 % 编码
for (const k of webdavStore.keys()) {
  assert(!k.includes("%"), "WebDAV 存储路径无 % 编码: " + k);
}

// 5) MKCOL 目录 URL 必须以 / 结尾(与主控 webdav.js 一致;部分 NAS 否则建目录失败)
for (const u of mkcolUrls) {
  assert(u.endsWith("/"), "MKCOL 目录 URL 以 / 结尾(避免 NAS 建目录 409/405): " + u);
}

// 6) 删除当前抓取账号:清本地缓存 + 从 WebDAV 移除该 uin + 加墓碑(跨设备删除传播)
const del = await send({ action: "deleteCapture" });
assert(del.ok === true, "deleteCapture 返回 ok");
assert(del.uin === "9876543210", "删除的是最后抓取的账号(与缓存一致)");
assert(del.webdav && del.webdav.removed === true, "云端 WebDAV 已移除该账号");
const remote3 = JSON.parse(webdavStore.get(FILE_URL));
assert(remote3.accounts.length === 1, "删除后远端账号池剩 1 个");
assert(remote3.accounts[0].uin === "1234567890", "被删账号已从远端移除(非覆盖全部)");
assert(
  Array.isArray(remote3.tombstones) && remote3.tombstones.some((t) => t.uin === "9876543210"),
  "删除已写入墓碑(服务器下次同步也删除,不会一同步又回来)"
);

console.log(`\n==== extension-capture: ${passed} 断言通过 ====`);
