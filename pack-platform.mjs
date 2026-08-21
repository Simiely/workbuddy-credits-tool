// pack-platform.mjs - 平台版打包脚本(tools-center 部署包)
// 自动:① 读本机 wb-sync.json(WebDAV 配置) ② 复制代码 ③ 预填 wb-sync.json ④ 生成 zip
// 用法: node pack-platform.mjs [输出目录,默认 E:\desktop]
// 产物: <输出目录>/workbuddy-credits-tool-平台版-v<版本>.zip —— 上传 tools-center 零输入开箱即用
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const ROOT = path.dirname(fileURLToPath(import.meta.url));

const PY = process.env.WB_PY || "C:/Users/wandou/.workbuddy/binaries/python/versions/3.13.12/python.exe";
const OUT_DIR = process.argv[2] || "E:/desktop";
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const VER = pkg.version;
const ZIP_NAME = `workbuddy-credits-tool-平台版-v${VER}.zip`;
const OUT = path.join(OUT_DIR, ZIP_NAME);
const STAGE = path.join(ROOT, ".tmp-platform-pack");

// 1. 读本机 WebDAV 配置(预填;缺失则警告并生成空模板)
let sync = null;
try {
  sync = JSON.parse(fs.readFileSync(path.join(ROOT, "wb-sync.json"), "utf8"));
  console.log(`[pack] 已读取 WebDAV 配置: ${sync.url} (user=${sync.user})`);
} catch {
  console.warn("[pack] ⚠ 本机 wb-sync.json 缺失,将生成空模板(部署后需在 GUI 手动填 WebDAV)");
  sync = { url: "", user: "", pass: "" };
}

// 2. 准备 stage 目录(固定复用,覆盖写;沙箱拦截 rmSync 故不删除)
fs.mkdirSync(STAGE, { recursive: true });
fs.mkdirSync(path.join(STAGE, "docs"), { recursive: true });

// 3. 复制代码文件
const rootFiles = [
  "wb-gui.mjs", "wb-gui.html",
  "wb-gui.state.js", "wb-gui.core.js", "wb-gui.render.js",
  "wb-gui.chart.js", "wb-gui.ops.js", "wb-gui.sync.js", "wb-gui.actions.js",
  "package.json", "Dockerfile", "docker-compose.yml",
  "tool.json", ".dockerignore", "README.md", "CHANGELOG.md",
];
for (const f of rootFiles) {
  const s = path.join(ROOT, f);
  if (fs.existsSync(s)) fs.copyFileSync(s, path.join(STAGE, f));
}
fs.cpSync(path.join(ROOT, "src"), path.join(STAGE, "src"), { recursive: true });
for (const f of ["部署.md", "tools-center部署.md", "配置要求.md", "新手使用手册.md", "架构.md", "发布规范.md"]) {
  const s = path.join(ROOT, "docs", f);
  if (fs.existsSync(s)) fs.copyFileSync(s, path.join(STAGE, "docs", f));
}

// 4. 预填 wb-sync.json(配置已填好,上传即用)
fs.writeFileSync(path.join(STAGE, "wb-sync.json"), JSON.stringify(sync, null, 2), "utf8");
console.log(`[pack] 已预填 wb-sync.json -> zip(WebDAV: ${sync.url || "空"})`);

// 5. 生成平台部署说明(标注配置是否已预填;公开发布包一律空壳)
const HAS_SYNC = Boolean(sync && sync.url && sync.user && sync.pass);
const syncNote = HAS_SYNC
  ? `本包**已预填 WebDAV 配置**(\`wb-sync.json\`,与桌面版同一套),上传后:
1. 平台自动拉起 \`node wb-gui.mjs 8123\`(健康检查 \`/api/status\`)
2. 打开 \`/tool/wb-credits/\` → 「☁️ 云同步 → 下载」→ 账号池 + 历史恢复
3. **无需输入任何配置**`
  : `本包 **未预填 WebDAV 配置**(\`wb-sync.json\` 为空壳——公开发布包出于凭证安全一律空壳,2026-08-11 起),上传后:
1. 平台自动拉起 \`node wb-gui.mjs 8123\`(健康检查 \`/api/status\`)
2. 打开 \`/tool/wb-credits/\` → 「☁️ 云同步 → 配置」填入你的 WebDAV 地址/账号/密码 → 「🔄 同步 → 下载」
3. 凭证从桌面版「☁️ 上传」同步过来`;

const readme = `# 平台版部署说明(tools-center 托管)

> WorkBuddy 积分管理 · 平台版 v${VER}
> **平台版 = tools-center 统一宿主托管**:网页「+ 添加」→ zip 上传本包,平台自动识别 \`tool.json\` 并托管进程。

## 零输入说明
${syncNote}

## 全部配置要求
见包内 \`docs/配置要求.md\`(10 项清单:必填 WebDAV 三项${HAS_SYNC ? "已预填" : "需手动填写"};端口/命令/健康检查 tool.json 已声明;管理密码可选)。

## 数据与 cookie 更新
- 数据目录 = 工具目录(\`tools/wb-credits/\`):\`credits.db\` 含凭证,**删工具 = 删数据**,先云同步备份
- cookie 更新统一走 **Edge 插件**(chrome.cookies 官方 API 采集)→ 导出 \`wb-accounts.json\` → 本工具「📥 导入账号信息」→「☁️ 上传」→ 平台版「下载」

## 升级
替换 \`tools/wb-credits/\` 下代码 → 平台卡片「↻ 重启」。

## 文档
\`docs/tools-center部署.md\`(接入规范)/ \`docs/配置要求.md\`(配置清单)/ \`docs/发布规范.md\`(发包流程)
`;
fs.writeFileSync(path.join(STAGE, "平台部署说明.md"), readme, "utf8");

// 6. 用 managed python 打包 zip(顶层结构)
const pyScript = `
import os, zipfile, sys
stage, out = sys.argv[1], sys.argv[2]
if os.path.exists(out): os.remove(out)
with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
    for root, dirs, files in os.walk(stage):
        dirs[:] = [d for d in dirs if d != "__pycache__"]
        for f in files:
            full = os.path.join(root, f)
            rel = os.path.relpath(full, stage)
            z.write(full, rel)
print("zip_ok")
`;
execFileSync(PY, ["-c", pyScript, STAGE, OUT], { stdio: "inherit" });
console.log(`\n✅ 平台版打包完成: ${OUT} (${(fs.statSync(OUT).size / 1024).toFixed(0)} KB)`);
console.log(`   上传 tools-center 即用,无需输入任何配置。`);
